export { createIdentityConfiguration } from "./configuration";
export { openEncryptedData, sealEncryptedData, validateEncryptionSecrets } from "./encryption";
export { createPasskeyAuthentication } from "./passkey";
export {
  accountSubjectWebAuthnUserId,
  canonicalPasskeyUsername,
  createPasskeyUsernameGenerator,
  normalizePasskeyUsername,
  passkeyAccountSubject,
  passkeyDisplayName,
  type PasskeyUsernameGeneratorOptions,
  passkeyWebAuthnUserId,
} from "./passkey-username";
export { isIdentityPasskey, storedPasskeyPublicKeyBytes } from "./passkey-public-key";
export {
  type CapturedProfile,
  captureProviderProfile,
  createProfileClaimResolver,
  type ProfileClaims,
  openProfileEncryptedData,
  sealProfileEncryptedData,
  type ProfileIdentityUser,
} from "./profile";
export { createEthereumAuthentication } from "./siwe";
export { createSessionClaimResolver } from "./session";
export {
  accountSubject,
  type AuthenticationProvider,
  ethereumUpstreamId,
  isSocialProvider,
  pairwiseSubject,
  passkeyUpstreamId,
  providerSubject,
  sha256Hex,
  SOCIAL_PROVIDERS,
  type SocialProvider,
} from "./subjects";
