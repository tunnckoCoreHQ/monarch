import { createCimdClientDiscovery, type CimdAdmissionDependencies } from "./cimd";
import { createPublicDcrOptions } from "./dcr";

export * from "./cimd";
export * from "./dcr";

export function createClientAdmissionFragment(dependencies: CimdAdmissionDependencies = {}) {
  const clientDiscovery = createCimdClientDiscovery(dependencies);

  return {
    oauthProvider: {
      ...createPublicDcrOptions(),
      extensions: [{ clientDiscovery }],
    },
  };
}
