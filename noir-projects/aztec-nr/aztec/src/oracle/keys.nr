use crate::protocol::{address::{AztecAddress, PartialAddress}, public_keys::{IvpkM, NpkM, OvpkM, PublicKeys, TpkM}};
use std::embedded_curve_ops::EmbeddedCurvePoint;

// TODO(F-498): review naming consistency
pub unconstrained fn get_public_keys_and_partial_address(address: AztecAddress) -> (PublicKeys, PartialAddress) {
    try_get_public_keys_and_partial_address(address).expect(f"Public keys not registered for account {address}")
}

#[oracle(aztec_utl_getPublicKeysAndPartialAddress)]
unconstrained fn get_public_keys_and_partial_address_oracle(_address: AztecAddress) -> Option<[Field; 9]> {}

// TODO(F-498): review naming consistency
pub unconstrained fn try_get_public_keys_and_partial_address(
    address: AztecAddress,
) -> Option<(PublicKeys, PartialAddress)> {
    get_public_keys_and_partial_address_oracle(address).map(|result: [Field; 9]| {
        let keys = PublicKeys {
            npk_m: NpkM { inner: EmbeddedCurvePoint { x: result[0], y: result[1] } },
            ivpk_m: IvpkM { inner: EmbeddedCurvePoint { x: result[2], y: result[3] } },
            ovpk_m: OvpkM { inner: EmbeddedCurvePoint { x: result[4], y: result[5] } },
            tpk_m: TpkM { inner: EmbeddedCurvePoint { x: result[6], y: result[7] } },
        };

        let partial_address = PartialAddress::from_field(result[8]);

        (keys, partial_address)
    })
}
