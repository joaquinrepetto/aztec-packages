import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { Fr } from "@aztec/aztec.js/fields";
import { CallAuthorizationRequest } from "@aztec/aztec.js/authorization";

// Setup: connect to network, create alice and bob, deploy a token, mint to alice.
// EmbeddedWallet runs every .simulate() call in kernelless mode with a stub-account
// override applied automatically. The examples below rely on that default.
const node = createAztecNodeClient(
  process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
);
await waitForNode(node);
const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

const testAccounts = await getInitialTestAccountsData();
const [aliceAddress, bobAddress] = await Promise.all(
  testAccounts.slice(0, 2).map(async (account) => {
    return (
      await wallet.createSchnorrAccount(
        account.secret,
        account.salt,
        account.signingKey,
      )
    ).address;
  }),
);

const { contract: tokenContract } = await TokenContract.deploy(
  wallet,
  aliceAddress,
  "TestToken",
  "TST",
  18,
).send({ from: aliceAddress });

await tokenContract.methods
  .mint_to_private(aliceAddress, 1000n)
  .send({ from: aliceAddress });

// docs:start:simulate-view-without-signing
// Reading a private view function would normally route through the account
// contract's entrypoint, whose is_valid check would prompt the user to sign.
// With EmbeddedWallet, .simulate() runs kernelless with a stub-account
// override applied to alice's account, so no signing prompt is triggered.
const { result: decimals } = await tokenContract.methods
  .private_get_decimals()
  .simulate({ from: aliceAddress });

console.log("Token decimals (read via private view):", decimals);
// docs:end:simulate-view-without-signing

// docs:start:simulate-and-collect-effects
// Bob initiates a `transfer_in_private` that moves tokens from Alice to Bob.
// The token's #[authorize_once] macro requires Alice to have authorized this
// call. Simulating it through bob's wallet would normally fail or prompt
// Alice to sign. With kernelless + stub override, the simulation runs to
// completion and the macro emits a CallAuthorizationRequest as an offchain
// effect that the wallet can turn into a real authwit afterwards.
//
// `additionalScopes: [aliceAddress]` puts alice's account in scope so her
// account contract is also stubbed and her private state is accessible during
// simulation.
const transferAmount = 100n;
const authwitNonce = Fr.random();

const transferAction = tokenContract.methods.transfer_in_private(
  aliceAddress,
  bobAddress,
  transferAmount,
  authwitNonce,
);

const { offchainEffects } = await transferAction.simulate({
  from: bobAddress,
  additionalScopes: [aliceAddress],
  includeMetadata: true,
});

// Filter offchain effects for authwit requests by selector.
const authwitSelector = await CallAuthorizationRequest.getSelector();
const authwitEffects = offchainEffects.filter(
  (effect) =>
    effect.data.length > 0 && effect.data[0].equals(authwitSelector.toField()),
);

if (authwitEffects.length !== 1) {
  throw new Error(
    `Expected exactly one CallAuthorizationRequest, got ${authwitEffects.length}`,
  );
}
// docs:end:simulate-and-collect-effects

// docs:start:decode-call-authorization
// Decode each effect into a CallAuthorizationRequest. The inner hash is the
// piece alice's wallet needs to sign.
const authorizationRequests = await Promise.all(
  authwitEffects.map((effect) =>
    CallAuthorizationRequest.fromFields(effect.data),
  ),
);

for (const request of authorizationRequests) {
  console.log("Authwit needed:", {
    onBehalfOf: request.onBehalfOf.toString(),
    msgSender: request.msgSender.toString(),
    functionSelector: request.functionSelector.toString(),
  });
}

if (!authorizationRequests[0].onBehalfOf.equals(aliceAddress)) {
  throw new Error(
    `Expected onBehalfOf to be alice (${aliceAddress.toString()}), got ${authorizationRequests[0].onBehalfOf.toString()}`,
  );
}
// docs:end:decode-call-authorization

// docs:start:build-authwits-and-send
// Alice creates a real authentication witness from each inner hash. The
// `consumer` is the contract that will consume the authwit (the token here).
const authWitnesses = await Promise.all(
  authorizationRequests.map((request) =>
    wallet.createAuthWit(request.onBehalfOf, {
      consumer: tokenContract.address,
      innerHash: request.innerHash,
    }),
  ),
);

// Bob now sends the real transaction with the collected authwits attached.
//
// Note: EmbeddedWallet.sendTx already runs this pre-simulation + authwit
// collection internally, so passing `authWitnesses` here is redundant for
// EmbeddedWallet. We pass them explicitly anyway because this is the pattern
// a wallet that does not auto-collect needs to follow.
await transferAction.send({
  from: bobAddress,
  authWitnesses,
  additionalScopes: [aliceAddress],
});
// docs:end:build-authwits-and-send

console.log("Kernelless simulation example completed successfully");
