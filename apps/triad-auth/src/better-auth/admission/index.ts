import { createCimdClientDiscovery, type CimdAdmissionDependencies } from "./cimd";
import { createPublicDcrOptions, publicDcrGuard } from "./dcr";

export * from "./cimd";
export * from "./dcr";

export function createClientAdmissionFragment(dependencies: CimdAdmissionDependencies = {}) {
  const clientDiscovery = createCimdClientDiscovery(dependencies);

  return {
    betterAuthPlugins: [publicDcrGuard],
    oauthProvider: {
      ...createPublicDcrOptions(),
      extensions: [{ clientDiscovery }],
    },
  };
}
