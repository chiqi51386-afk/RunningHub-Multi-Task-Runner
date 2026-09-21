export interface SecretStore {
  encrypt(value: string): Buffer | string;
  decrypt(value: Buffer | string): string;
}

/** API keys are deliberately stored as local plaintext. */
export class PlainTextSecretStore implements SecretStore {
  encrypt(value: string): string {
    return value;
  }
  decrypt(value: Buffer | string): string {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    if (!/^[\x20-\x7e]+$/.test(text)) {
      throw new Error("Stored API key is not plaintext and must be entered again.");
    }
    return text;
  }
}

export class InMemorySecretStore extends PlainTextSecretStore {}

export class UnsupportedPersistentSecretStore implements SecretStore {
  encrypt(): never {
    throw new Error("A persistent SecretStore is required.");
  }
  decrypt(): never {
    throw new Error("A persistent SecretStore is required.");
  }
}
