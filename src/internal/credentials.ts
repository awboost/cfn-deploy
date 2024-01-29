import { AwsVaultCredentials } from "@awboost/aws-vault-credentials";
import type { AwsCredentialIdentity, Provider } from "@aws-sdk/types";

export type CredentialOptions = {
  accessKeyId?: string;
  profile?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export function getCredentials(
  options: CredentialOptions,
): AwsCredentialIdentity | Provider<AwsCredentialIdentity> | undefined {
  if (options.accessKeyId) {
    return {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey!,
      sessionToken: options.sessionToken,
    };
  }
  if (options.profile) {
    return AwsVaultCredentials.provide({
      profileName: options.profile,
    });
  }
}
