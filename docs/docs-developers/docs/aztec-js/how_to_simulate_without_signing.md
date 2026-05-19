---
title: Simulate without signing prompts
tags: [simulation, authwit, wallet]
sidebar_position: 6
description: How to call .simulate() on a view function or estimate gas without prompting the user to sign authentication witnesses.
---

You want to call `.simulate()` from a dApp and not have the user's wallet pop up a signing prompt. This page covers the symptoms that lead to that prompt, why the obvious workarounds do not work, and the right fix.

For the conceptual model of what kernelless simulation is, see [Kernelless simulations](../foundational-topics/pxe/kernelless_simulations.md).

## Symptoms

You are probably here because of one of these:

- The wallet prompts the user for a signature on every `.simulate()` call, including reads of view-style functions.
- `.simulate()` fails with `Circuit execution failed: min_revertible_side_effect_counter must not be 0 for tail_to_public` when you pass `from: AztecAddress.ZERO` and no fee block.
- A custom fee payment method breaks during simulation because `from` is `AztecAddress.ZERO`.
- Simulations take long enough that you want to skip the kernel proving step.

## The wrong fix

Do not use `from: AztecAddress.ZERO` as a workaround for the signing prompt. That value has a specific meaning in the Private eXecution Environment (PXE): it tells the wallet to execute the payload through the default entrypoint with no account contract mediation. Combined with no fee payment method, it skips the setup phase that ends with `end_setup()`, which is what produces the `min_revertible_side_effect_counter must not be 0` error.

Do not deploy a sham "no-op" fee payment contract just to satisfy the simulation. The PXE already supports the use case you want; it just needs to be told to use it.

## The right fix

Run the simulation with a **stub account contract override**. The PXE swaps your account contract for one whose `is_valid` always returns true, so authwit validity checks pass without a signature. The wallet then collects any `CallAuthorizationRequest` offchain effects from the simulation and turns them into real authentication witnesses for the actual `.send()`.

`EmbeddedWallet` installs the stub-account override automatically on every `.simulate()` call, so most dApps do not need to construct overrides themselves. The two ways to wire this up below correspond to "use the default" and "implement it in your own wallet."

### As a dApp caller

For a normal `.simulate()` you do not need to pass overrides yourself. The default simulation path is already kernelless, and wallets such as `EmbeddedWallet` install the stub-account override internally for you. Three things to remember:

- Pass a real account address as `from`, not `AztecAddress.ZERO`.
- Omit the `fee` block; this is a simulation, not a real transaction.
- If you have a stale call site that uses `from: AztecAddress.ZERO` plus a no-op fee payment method as a workaround, replace it with a real `from` and drop the fee block.

#include_code simulate-view-without-signing /docs/examples/ts/aztecjs_kernelless_simulation/index.ts typescript

If you genuinely need to construct your own `SimulationOverrides` (for example, to combine a contract-instance swap with a `fastForwardContractUpdate` for upgrade testing), you can pass them through `.simulate()`:

```typescript
import { SimulationOverrides } from '@aztec/aztec.js/wallet';

const { result } = await contract.methods.transfer_in_private(sender, recipient, amount, nonce).simulate({
  from: sender,
  overrides: new SimulationOverrides({ /* contracts and/or publicStorage */ }),
});
```

The override map itself has to be built by code that knows the contract class id and live contract instance. That is normally the wallet, not the dApp. Note that `overrides` does not apply to [utility functions](../foundational-topics/pxe/kernelless_simulations.md#where-kernelless-does-not-apply): those are simulated through `wallet.executeUtility`, which rejects `SimulationOverrides`. If your wallet does not handle the override path for you and you are tempted to reimplement it in dApp code, read the next section instead.

### As a wallet implementer

`EmbeddedWallet` (`yarn-project/wallets/src/embedded/embedded_wallet.ts`) is the canonical in-tree implementation of the override pattern. The three pieces it wires up are:

1. **Register the stub contract class with the PXE at wallet startup.** Inside `initStubClasses`, `EmbeddedWallet` calls `pxe.registerContractClass` for each supported account type's stub artifact and caches the resulting class id by account type.
2. **Build an override map for every account in scope.** Inside `buildAccountOverrides`, it fetches the live contract instance for each scoped address and returns a `ContractOverrides` map that copies the instance with `currentContractClassId` rewritten to the stub class id. The map covers every account in scope, not only `from`.
3. **Use the stub entrypoint and pass the override to `pxe.simulateTx`.** Inside the overridden `simulateViaEntrypoint`, it constructs the `TxExecutionRequest` through the stub account's `DefaultAccountEntrypoint` (so the request is signed by the stub's empty-signature provider) and calls `pxe.simulateTx` with the resulting `SimulationOverrides`. `TestWallet` (`yarn-project/end-to-end/src/test-wallet/test_wallet.ts`) implements the same three steps in a simpler form for end-to-end tests.

The key constraints on this path:

- `skipKernels` must be `true` to use `contracts` overrides. The PXE rejects the combination otherwise. `pxe.simulateTx` already defaults `skipKernels` to `true`.
- The stub contract class must be registered with the PXE before you reference it in an override.
- The override map must cover every scoped account, not only `from`.

## Collecting authwit requests

A simulation with the stub override active will reach `#[authorize_once]` call sites in the app and token contracts without prompting for signatures. Each such site emits a `CallAuthorizationRequest` as an offchain effect, which the wallet can collect and turn into a real authentication witness for the eventual `.send()`.

Run the simulation and filter the offchain effects by the `CallAuthorizationRequest` selector:

#include_code simulate-and-collect-effects /docs/examples/ts/aztecjs_kernelless_simulation/index.ts typescript

Decode each effect into a `CallAuthorizationRequest`. The `innerHash` field is the piece the authorizing account needs to sign:

#include_code decode-call-authorization /docs/examples/ts/aztecjs_kernelless_simulation/index.ts typescript

Build a real authentication witness from each inner hash and send the transaction with the collected witnesses attached:

#include_code build-authwits-and-send /docs/examples/ts/aztecjs_kernelless_simulation/index.ts typescript

The dApp does not need to know which calls require authwits ahead of time. The simulation discovers them; the wallet signs them at send time.

`EmbeddedWallet.sendTx` runs this same simulate-then-collect flow internally before delegating to `BaseWallet.sendTx`, so a dApp that uses `EmbeddedWallet` does not need to call `.simulate()` manually and pass `authWitnesses` to `.send()`. The explicit pattern above is the one a wallet that does not auto-collect must implement, either inside its `sendTx` (as `EmbeddedWallet` does) or inside the dApp call site.

## Things to watch out for

- **`AztecAddress.ZERO` is not "no sender".** Use a real account address with overrides instead. Reserve `AztecAddress.ZERO` (or `NO_FROM`) for calls that genuinely have no account context.
- **Private fee payment contracts can skew gas estimates.** Kernelless simulation matches full simulation on gas in the common case, but a private fee payment contract (FPC) that holds notes is a known edge case. If you need exact gas for a tx that pays through a private FPC, run a full simulation as a sanity check.
- **`profile()` is not kernelless.** If you call `.profile()` to count circuit gates, the kernels run regardless. Use `.simulate()` if you only need return values, offchain effects, or gas estimates.
- **Utility functions ignore overrides.** `FunctionType.UTILITY` calls go through a different code path and reject `SimulationOverrides`. They do not need an override anyway, since they do not run through an account contract.
- **Wallet-wide simulation toggles can race.** If your wallet exposes a single mode flag (the way `TestWallet.setSimulationMode` does), concurrent `.simulate()` calls from different parts of the UI can see each other's state. Prefer per-call overrides via `SimulationOverrides` for production wallets.

## Related

- [Kernelless simulations](../foundational-topics/pxe/kernelless_simulations.md) for the conceptual model.
- [Reading contract data](./how_to_read_data.md) for the basic `.simulate()` API.
- [Authentication witnesses](../foundational-topics/advanced/authwit.md) for what `CallAuthorizationRequest` represents.
