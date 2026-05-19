use crate::traits::{Deserialize, Empty, Serialize};
use std::{embedded_curve_ops::EmbeddedCurvePoint, meta::derive};

#[derive(Deserialize, Eq, Serialize)]
pub struct KeyValidationRequest {
    pub pk_m: EmbeddedCurvePoint,
    pub sk_app: Field, // not a grumpkin scalar because it's output of poseidon2
}

impl Empty for KeyValidationRequest {
    fn empty() -> Self {
        // TODO(MW): Previously an empty request had a point rep. by { 0, 0, 0}, but now we use 2 elts. Ok to use (0, 0) = inf here?
        KeyValidationRequest { pk_m: EmbeddedCurvePoint { x: 0, y: 0 }, sk_app: 0 }
    }
}

mod test {
    use crate::{
        abis::validation_requests::key_validation_request::KeyValidationRequest,
        constants::KEY_VALIDATION_REQUEST_LENGTH,
        traits::{Deserialize, Serialize},
    };
    use std::embedded_curve_ops::EmbeddedCurvePoint;

    #[test]
    fn serialization_of_key_validation_request() {
        let item =
            KeyValidationRequest { pk_m: EmbeddedCurvePoint::deserialize([123, 456]), sk_app: 789 };
        // We use the KEY_VALIDATION_REQUEST_LENGTH constant to ensure that there is a match between the derived trait
        // implementation and the constant.
        let serialized: [Field; KEY_VALIDATION_REQUEST_LENGTH] = item.serialize();
        let deserialized = KeyValidationRequest::deserialize(serialized);
        assert_eq(item, deserialized);
    }
}
