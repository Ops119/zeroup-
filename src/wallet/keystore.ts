import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { scrypt } from "@noble/hashes/scrypt";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";

/** Passphrase-encrypted mnemonic on disk (scrypt + XChaCha20-Poly1305). */
interface KeystoreFile {
  version: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "xchacha20poly1305"; nonce: string };
  ciphertext: string;
}

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };

export function writeKeystore(file: string, mnemonic: string, passphrase: string): void {
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = scrypt(passphrase, salt, { ...PARAMS, dkLen: 32 });
  const ct = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(mnemonic));
  const ks: KeystoreFile = {
    version: 1,
    kdf: { name: "scrypt", ...PARAMS, salt: Buffer.from(salt).toString("hex") },
    cipher: { name: "xchacha20poly1305", nonce: Buffer.from(nonce).toString("hex") },
    ciphertext: Buffer.from(ct).toString("hex"),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ks, null, 2), { mode: 0o600 });
}

export function readKeystore(file: string, passphrase: string): string {
  const ks = JSON.parse(fs.readFileSync(file, "utf8")) as KeystoreFile;
  const key = scrypt(passphrase, Buffer.from(ks.kdf.salt, "hex"), { N: ks.kdf.N, r: ks.kdf.r, p: ks.kdf.p, dkLen: 32 });
  try {
    const pt = xchacha20poly1305(key, Buffer.from(ks.cipher.nonce, "hex")).decrypt(Buffer.from(ks.ciphertext, "hex"));
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("wrong passphrase or corrupted keystore");
  }
}
