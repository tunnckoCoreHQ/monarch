---
"@tunnckocore/ethscriptions-core": minor
---

Move the `ethscriptions` library into monarch as `@tunnckocore/ethscriptions-core`, from version 0.11.3. The `./orpc` export is gone. The `bufferFee` cost option is now `buffer_fee`, `bytesToHex` pads single-digit bytes, and an attachment without a content type gets no `content-type` header.
