# Changelog

Every version of `@basilbook/acleda`, newest first. The PHP twin `basilbook/acleda` carries the same
version for the same change: the same calls, checked against the same test vectors. Versions follow
[semantic versioning](https://semver.org).

## 0.1.0 — unreleased

The first release, taken out of Bill&Go.

- `AcledaClient`: `open` (KHQR text, or an image with `format: 'image'`), `status` (paid only on proof), `refund`.
- Signing and addresses: `acledaHash`, `acledaUrl`, `acledaPurchaseDate`; the one-time callback token: `acledaCallbackToken`, `acledaCallbackUrl`, `acledaCallbackTokenHash`, `verifyAcledaCallback`.
- Typed errors: `AcledaConfigError`, `AcledaInputError`, `AcledaRefusedError`, `AcledaUnreachableError`.
