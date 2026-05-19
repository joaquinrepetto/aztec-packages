use crate::{
    address::public_keys_hash::PublicKeysHash,
    constants::{
        DEFAULT_IVPK_M_X, DEFAULT_IVPK_M_Y, DEFAULT_NPK_M_X, DEFAULT_NPK_M_Y, DEFAULT_OVPK_M_X,
        DEFAULT_OVPK_M_Y, DEFAULT_TPK_M_X, DEFAULT_TPK_M_Y, DOM_SEP__PUBLIC_KEYS_HASH,
    },
    hash::{poseidon2_hash, poseidon2_hash_with_separator},
    traits::{Deserialize, Hash, Serialize},
};

use std::{default::Default, embedded_curve_ops::EmbeddedCurvePoint, meta::derive};

// TODO(MW): manually defining here for now. Will be removed - but noir doesnt seem to have a native one?
// TODO(MW): combine one fn for checking on curve and non-inf?
pub fn validate_on_curve(p: EmbeddedCurvePoint) {
    // y^2 == x^3 - 17
    let x = p.x;
    let y = p.y;
    // p.is_infinite() <==> x == y == 0, considered on the curve:
    if !p.is_infinite() {
        assert_eq(y * y, x * x * x - 17, "Point not on curve");
    }
}

// TODO(MW): manually inserting is_infinite = 0 just so tests etc pass with hash result. Will be removed.
fn temp_serialize_with_inf(p: EmbeddedCurvePoint) -> [Field; 3] {
    [p.x, p.y, p.is_infinite() as Field]
}

pub trait ToPoint {
    fn to_point(self) -> EmbeddedCurvePoint;
}

#[derive(Deserialize, Eq, Serialize)]
pub struct NpkM {
    pub inner: EmbeddedCurvePoint,
}

impl ToPoint for NpkM {
    fn to_point(self) -> EmbeddedCurvePoint {
        self.inner
    }
}
// Note: If we store npk_m_hash directly we can remove this trait implementation. See #8091
impl Hash for NpkM {
    // TODO(MW): EmbeddedCurvePoint's native hasher doesnt appear to serialise then hash, for now using this.
    fn hash(self) -> Field {
        poseidon2_hash(temp_serialize_with_inf(self.inner))
    }
}

#[derive(Deserialize, Eq, Serialize)]
pub struct IvpkM {
    pub inner: EmbeddedCurvePoint,
}

impl ToPoint for IvpkM {
    fn to_point(self) -> EmbeddedCurvePoint {
        self.inner
    }
}

#[derive(Deserialize, Eq, Serialize)]
pub struct OvpkM {
    pub inner: EmbeddedCurvePoint,
}

impl Hash for OvpkM {
    // TODO(MW): EmbeddedCurvePoint's native hasher doesnt appear to serialise then hash, for now using this.
    fn hash(self) -> Field {
        poseidon2_hash(temp_serialize_with_inf(self.inner))
    }
}

impl ToPoint for OvpkM {
    fn to_point(self) -> EmbeddedCurvePoint {
        self.inner
    }
}

#[derive(Deserialize, Eq, Serialize)]
pub struct TpkM {
    pub inner: EmbeddedCurvePoint,
}

impl ToPoint for TpkM {
    fn to_point(self) -> EmbeddedCurvePoint {
        self.inner
    }
}

#[derive(Deserialize, Eq, Serialize)]
pub struct PublicKeys {
    pub npk_m: NpkM,
    pub ivpk_m: IvpkM,
    pub ovpk_m: OvpkM,
    pub tpk_m: TpkM,
}

impl Default for PublicKeys {
    fn default() -> Self {
        PublicKeys {
            npk_m: NpkM { inner: EmbeddedCurvePoint { x: DEFAULT_NPK_M_X, y: DEFAULT_NPK_M_Y } },
            ivpk_m: IvpkM {
                inner: EmbeddedCurvePoint { x: DEFAULT_IVPK_M_X, y: DEFAULT_IVPK_M_Y },
            },
            ovpk_m: OvpkM {
                inner: EmbeddedCurvePoint { x: DEFAULT_OVPK_M_X, y: DEFAULT_OVPK_M_Y },
            },
            tpk_m: TpkM { inner: EmbeddedCurvePoint { x: DEFAULT_TPK_M_X, y: DEFAULT_TPK_M_Y } },
        }
    }
}

impl PublicKeys {
    pub fn hash(self) -> PublicKeysHash {
        // PublicKeysHash::from_field(poseidon2_hash_with_separator(
        //     self.serialize(),
        //     DOM_SEP__PUBLIC_KEYS_HASH as Field,
        // ))
        // TODO(MW): Temporary for tests/fixtures to pass while 3 elts are used. Will be removed.
        let temp_preimage: [Field; 12] = temp_serialize_with_inf(self.npk_m.inner)
            .concat(temp_serialize_with_inf(self.ivpk_m.inner))
            .concat(temp_serialize_with_inf(self.ovpk_m.inner))
            .concat(temp_serialize_with_inf(self.tpk_m.inner));
        PublicKeysHash::from_field(poseidon2_hash_with_separator(
            temp_preimage,
            DOM_SEP__PUBLIC_KEYS_HASH as Field,
        ))
    }

    pub fn validate_on_curve(self) {
        validate_on_curve(self.npk_m.inner);
        validate_on_curve(self.ivpk_m.inner);
        validate_on_curve(self.ovpk_m.inner);
        validate_on_curve(self.tpk_m.inner);
    }

    pub fn validate_non_infinity(self) {
        assert_eq(self.npk_m.inner.is_infinite(), false, "NpkM is the point at infinity");
        assert_eq(self.ivpk_m.inner.is_infinite(), false, "IvpkM is the point at infinity");
        assert_eq(self.ovpk_m.inner.is_infinite(), false, "OvpkM is the point at infinity");
        assert_eq(self.tpk_m.inner.is_infinite(), false, "TpkM is the point at infinity");
    }
}

// TODO(MW): Remove now that we just use EmbeddedCurvePoint?
pub struct AddressPoint {
    pub inner: EmbeddedCurvePoint,
}

impl ToPoint for AddressPoint {
    fn to_point(self) -> EmbeddedCurvePoint {
        self.inner
    }
}

mod test {
    use crate::{
        public_keys::{IvpkM, NpkM, OvpkM, PublicKeys, TpkM},
        traits::{Deserialize, Serialize},
    };
    use std::embedded_curve_ops::EmbeddedCurvePoint;
    use std::ops::Neg;

    #[test]
    unconstrained fn compute_public_keys_hash() {
        let keys = PublicKeys {
            npk_m: NpkM { inner: EmbeddedCurvePoint { x: 1, y: 2 } },
            ivpk_m: IvpkM { inner: EmbeddedCurvePoint { x: 3, y: 4 } },
            ovpk_m: OvpkM { inner: EmbeddedCurvePoint { x: 5, y: 6 } },
            tpk_m: TpkM { inner: EmbeddedCurvePoint { x: 7, y: 8 } },
        };

        let actual = keys.hash();

        // The following value was generated by `public_keys.test.ts`.
        let expected_public_keys_hash =
            0x056998309f6c119e4d753e404f94fef859dddfa530a9379634ceb0854b29bf7a;

        assert(actual.to_field() == expected_public_keys_hash);
    }

    #[test]
    unconstrained fn test_validate_on_curve() {
        let keys = PublicKeys {
            npk_m: NpkM { inner: EmbeddedCurvePoint::generator() },
            ivpk_m: IvpkM { inner: EmbeddedCurvePoint::generator().double() },
            ovpk_m: OvpkM { inner: EmbeddedCurvePoint::generator().neg() },
            tpk_m: TpkM {
                inner: EmbeddedCurvePoint::generator() + EmbeddedCurvePoint::generator().double(),
            },
        };

        keys.validate_on_curve();
    }

    #[test(should_fail_with = "Point not on curve")]
    unconstrained fn test_validate_not_on_curve() {
        let keys = PublicKeys {
            npk_m: NpkM { inner: EmbeddedCurvePoint { x: 1, y: 2 } },
            ivpk_m: IvpkM { inner: EmbeddedCurvePoint { x: 3, y: 4 } },
            ovpk_m: OvpkM { inner: EmbeddedCurvePoint { x: 5, y: 6 } },
            tpk_m: TpkM { inner: EmbeddedCurvePoint { x: 7, y: 8 } },
        };

        keys.validate_on_curve();
    }

    #[test]
    unconstrained fn test_validate_non_infinity() {
        let keys = PublicKeys {
            npk_m: NpkM { inner: EmbeddedCurvePoint::generator() },
            ivpk_m: IvpkM { inner: EmbeddedCurvePoint::generator().double() },
            ovpk_m: OvpkM { inner: EmbeddedCurvePoint::generator().neg() },
            tpk_m: TpkM {
                inner: EmbeddedCurvePoint::generator() + EmbeddedCurvePoint::generator().double(),
            },
        };

        keys.validate_non_infinity();
    }

    #[test(should_fail_with = "TpkM is the point at infinity")]
    unconstrained fn test_validate_infinity() {
        let keys = PublicKeys {
            npk_m: NpkM { inner: EmbeddedCurvePoint::generator() },
            ivpk_m: IvpkM { inner: EmbeddedCurvePoint::generator().double() },
            ovpk_m: OvpkM { inner: EmbeddedCurvePoint::generator().neg() },
            tpk_m: TpkM { inner: EmbeddedCurvePoint::point_at_infinity() },
        };

        keys.validate_non_infinity();
    }

    #[test]
    unconstrained fn compute_default_hash() {
        let keys = PublicKeys::default();

        let actual = keys.hash();

        // The following value was generated by `public_keys.test.ts`.
        let test_data_default_hash =
            0x023547e676dba19784188825b901a0e70d8ad978300d21d6185a54281b734da0;

        assert(actual.to_field() == test_data_default_hash);
    }

    #[test]
    unconstrained fn serde() {
        let keys = PublicKeys {
            npk_m: NpkM { inner: EmbeddedCurvePoint { x: 1, y: 2 } },
            ivpk_m: IvpkM { inner: EmbeddedCurvePoint { x: 3, y: 4 } },
            ovpk_m: OvpkM { inner: EmbeddedCurvePoint { x: 5, y: 6 } },
            tpk_m: TpkM { inner: EmbeddedCurvePoint { x: 7, y: 8 } },
        };

        let serialized = keys.serialize();
        let deserialized = PublicKeys::deserialize(serialized);

        assert_eq(keys, deserialized);
    }
}
