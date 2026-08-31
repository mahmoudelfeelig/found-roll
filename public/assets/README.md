# Synthetic fixture asset manifest

These five public JPEGs were generated specifically for Found Roll with OpenAI's built-in image generation tool on August 29, 2026. They depict a fictional camera pouch and fictional intake contexts. They contain no real claimant, custodian, location, identity document, credential, serial answer, or physical-handoff evidence.

The files under this public directory are claimant-safe presentation replicas for the local web prototype. They are not the canonical private-evidence objects. A live Google Cloud run uploads an authorized source through the staff evidence API, stores the original and derivative in the configured private Cloud Storage bucket, and passes only the explicitly model-authorized derivative to Vertex AI.

| File | Intended prototype use | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `claimant-match.jpg` | Claimant-supplied context replica | 303802 | `e5f8f907e9fcc2e21415b41218faea6ef11f783827aa6409aaba32defb6e64ed` |
| `northport-intake.jpg` | Fictional intake context | 404870 | `460bce72c0d68f8f26ae7f5f4d03b6cfc8975f239815580de511be3933d062ed` |
| `pouch-front.jpg` | Model-safe front view and canonical upload source | 326943 | `7eecc012b0f8638fc59f2979ea0cdd3888e6cf5e9659eea2f30f0388bcea6d42` |
| `pouch-interior.jpg` | Model-safe open-pouch view | 329913 | `5a2dc95289981af12a057c3754d5df6140b67de842dc803a5092f5e9d1fb6b1e` |
| `pouch-rear.jpg` | Model-safe rear view | 347067 | `1768db7c0249316c55877a73d91bd09689118f800e7a40ff339d2cfea6a6b159` |

If any asset changes, regenerate every affected hash and rerun the publication privacy scan before recording or submitting.
