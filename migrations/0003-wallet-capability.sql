alter table "passkey" add column "walletCapable" integer not null default 0;

create table "walletCapabilityRequest" ("id" text not null primary key, "userId" text not null references "user" ("id") on delete cascade, "credentialId" text not null, "challenge" text not null, "signingMessage" text not null, "expiresAt" date not null, "consumedAt" date, "createdAt" date not null);

create index "walletCapabilityRequest_userId_idx" on "walletCapabilityRequest" ("userId");

create index "walletCapabilityRequest_expiresAt_idx" on "walletCapabilityRequest" ("expiresAt");
