export function createSessionClaimResolver(database: D1Database) {
  return {
    resolveAuthenticationChains: async (sessionId: string, userId: string) => {
      const [session, wallets] = await Promise.all([
        database
          .prepare(
            'select "authenticationChainId" from "session" where "id" = ? and "userId" = ? limit 1',
          )
          .bind(sessionId, userId)
          .first<{ authenticationChainId: unknown }>(),
        database
          .prepare('select "chainId" from "walletAddress" where "userId" = ?')
          .bind(userId)
          .all<{ chainId: unknown }>(),
      ]);
      const chainId = session?.authenticationChainId;

      return {
        chainId:
          typeof chainId === "number" && Number.isSafeInteger(chainId) && chainId > 0
            ? chainId
            : undefined,
        chains: wallets.results.map((wallet) => wallet.chainId),
      };
    },
  };
}
