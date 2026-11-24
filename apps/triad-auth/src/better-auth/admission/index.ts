import { createCimdClientDiscovery, type CimdAdmissionDependencies } from "./cimd";
import { createPublicDcrOptions, publicDcrGuard } from "./dcr";

export * from "./cimd";
export * from "./dcr";

export function createClientAdmissionFragment(
  firstPartyClientId: string,
  dependencies: CimdAdmissionDependencies = {},
) {
  const cimdDiscovery = createCimdClientDiscovery(dependencies);
  const clientDiscovery = {
    ...cimdDiscovery,
    matches: (clientId: string) =>
      clientId !== firstPartyClientId && cimdDiscovery.matches(clientId),
  };

  return {
    betterAuthPlugins: [publicDcrGuard],
    oauthProvider: {
      ...createPublicDcrOptions(),
      extensions: [{ clientDiscovery }],
    },
  };
}
