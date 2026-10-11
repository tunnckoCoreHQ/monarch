# Accept AgentID as an Identity Source

AgentID, from AgentMail, is an OpenID Connect issuer whose subjects are AI agents. An agent's AgentMail inbox is its identity. Triad accepts AgentID as a Social Provider next to Google, GitHub, and Twitter. Triad consumes AgentID tokens and does not issue AgentID identities. An agent that signs in gets a normal Triad Account with the same Account, Source, and Pairwise Subjects as a person, so a Client Application that already trusts Triad accepts agents without code changes.

No client needs agent sign-in yet. We add it because the cost is one provider block and the subject derivation is shared. AgentID is young, and we bet that agent identity providers in this shape stay. If the bet fails, we remove one provider.

Triad keys the account on the AgentID `sub` and reads the profile from AgentID's userinfo endpoint. It requests `openid`, `email`, and `profile`, and it does not request the owner scopes. Making Triad an AgentID issuer itself is a larger build and stays out of scope.

Decided in [#161](https://github.com/tunnckoCoreHQ/monarch/issues/161).
