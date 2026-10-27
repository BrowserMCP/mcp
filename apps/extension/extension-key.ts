/**
 * The public key in the manifest's `key`, from which Chrome derives the extension's ID, so every build has the same one (`SELF_BUILT_EXTENSION_ID` in `@browsermcp/protocol`), which the Browser MCP server accepts. Only the public key exists: Chrome loads unpacked extensions without the private one. The user still pairs the extension with the server (**Allow** after comparing the code)
 */
export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1BeDfTIiCM1Z5g26kvFvebDjQLZzvm0KWPOJytAb8fnOXtxblu3Mt9urC74J2cBop1CDYhgI6ZrFRn7TYsBEGNbv1t559mOxtEEhrE2e5CGfFfKxA75aB+la1bFx5iUrplZW8GF7m7ytfKd9Fn+eubmKb4c1B1pqguElVezKjQZqyZJR6UV2s/oJL2+SjgrmZDjIsuKWDSk50WcQ3za8rrXBTFrXJhKK1F/u0wKuBvTSMqLNlXoHNbtUaPVGjxB2opGqqdNsl433yKhHYVnrGAoVnoeeNJNvxhX6XuYapa879r3lV7uLxljeBasQ+CE1asqvUxVVHGnXpm/bWfD6JQIDAQAB";
