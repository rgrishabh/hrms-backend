import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { FieldCipher } from './index.js';

export interface KeySource {
  DATA_ENCRYPTION_KEY?: string;
  DATA_ENCRYPTION_KEY_PREVIOUS?: readonly string[];
  KMS_KEY_ID?: string;
  DATA_KEY_CIPHERTEXT?: string;
  DATA_KEY_CIPHERTEXT_PREVIOUS?: readonly string[];
  AWS_REGION?: string;
}

/** Unwraps a data key. The real one is KMS; tests supply their own. */
export type Unwrap = (ciphertextBase64: string, keyId: string) => Promise<string>;

export const kmsUnwrap = (region?: string): Unwrap => {
  const client = new KMSClient(region ? { region } : {});
  return async (ciphertextBase64, keyId) => {
    const r = await client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(ciphertextBase64, 'base64'), KeyId: keyId }));
    if (!r.Plaintext) throw new Error('KMS returned no plaintext for the data key');
    return Buffer.from(r.Plaintext).toString('base64');
  };
};

/**
 * KeyProvider. Production: KMS_KEY_ID and DATA_KEY_CIPHERTEXT, unwrapped once here, which takes priority. Development:
 * DATA_ENCRYPTION_KEY. The cipher it returns is synchronous from then on; nothing calls KMS per value.
 */
export async function loadFieldCipher(source: KeySource, unwrap?: Unwrap): Promise<FieldCipher> {
  if (source.KMS_KEY_ID && source.DATA_KEY_CIPHERTEXT) {
    const kms = unwrap ?? kmsUnwrap(source.AWS_REGION);
    const active = await kms(source.DATA_KEY_CIPHERTEXT, source.KMS_KEY_ID);
    const previous = await Promise.all((source.DATA_KEY_CIPHERTEXT_PREVIOUS ?? []).map((c) => kms(c, source.KMS_KEY_ID!)));
    return new FieldCipher(active, previous);
  }
  if (!source.DATA_ENCRYPTION_KEY) throw new Error('No data key: set KMS_KEY_ID and DATA_KEY_CIPHERTEXT, or DATA_ENCRYPTION_KEY');
  return new FieldCipher(source.DATA_ENCRYPTION_KEY, source.DATA_ENCRYPTION_KEY_PREVIOUS ?? []);
}

/** From raw process variables, for commands that do not load the whole deployment configuration. */
export function loadFieldCipherFromProcess(env: NodeJS.ProcessEnv = process.env): Promise<FieldCipher> {
  const list = (v?: string) =>
    (v ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  return loadFieldCipher({
    DATA_ENCRYPTION_KEY: env.DATA_ENCRYPTION_KEY || undefined,
    DATA_ENCRYPTION_KEY_PREVIOUS: list(env.DATA_ENCRYPTION_KEY_PREVIOUS),
    KMS_KEY_ID: env.KMS_KEY_ID || undefined,
    DATA_KEY_CIPHERTEXT: env.DATA_KEY_CIPHERTEXT || undefined,
    DATA_KEY_CIPHERTEXT_PREVIOUS: list(env.DATA_KEY_CIPHERTEXT_PREVIOUS),
    AWS_REGION: env.AWS_REGION || undefined,
  });
}
