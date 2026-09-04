create table "walletRequest" ("id" text not null primary key, "userId" text not null references "user" ("id") on delete cascade, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "credentialId" text not null, "redirectUri" text not null, "state" text not null, "message" text not null, "namespace" text not null, "namespaceSubject" text not null, "walletProfile" text not null, "accountIndex" integer not null, "chainId" integer, "derivationPath" text not null, "challenge" text not null, "signingMessage" text not null, "expiresAt" date not null, "consumedAt" date, "createdAt" date not null);

create index "walletRequest_userId_idx" on "walletRequest" ("userId");

create index "walletRequest_clientId_idx" on "walletRequest" ("clientId");

create index "walletRequest_expiresAt_idx" on "walletRequest" ("expiresAt");
