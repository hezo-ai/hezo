import type { KeyObject } from 'node:crypto';
import { sign } from 'node:crypto';

export const MSG_FAILURE = 5;
export const MSG_REQUEST_IDENTITIES = 11;
export const MSG_IDENTITIES_ANSWER = 12;
export const MSG_SIGN_REQUEST = 13;
export const MSG_SIGN_RESPONSE = 14;

export interface AgentIdentity {
	keyBlob: Buffer;
	comment: string;
}

export interface SignRequest {
	keyBlob: Buffer;
	data: Buffer;
	flags: number;
}

export type AgentMessage =
	| { type: typeof MSG_REQUEST_IDENTITIES }
	| { type: typeof MSG_SIGN_REQUEST; req: SignRequest }
	| { type: typeof MSG_FAILURE };

export function encodeIdentitiesAnswer(identities: readonly AgentIdentity[]): Buffer {
	const parts: Buffer[] = [];
	const nkeys = Buffer.alloc(4);
	nkeys.writeUInt32BE(identities.length, 0);
	parts.push(nkeys);
	for (const identity of identities) {
		parts.push(encodeString(identity.keyBlob));
		parts.push(encodeString(Buffer.from(identity.comment, 'utf8')));
	}
	return frameMessage(MSG_IDENTITIES_ANSWER, Buffer.concat(parts));
}

export function encodeSignResponse(signatureBlob: Buffer): Buffer {
	return frameMessage(MSG_SIGN_RESPONSE, encodeString(signatureBlob));
}

export function encodeFailure(): Buffer {
	return frameMessage(MSG_FAILURE, Buffer.alloc(0));
}

export function decodeMessage(payload: Buffer): AgentMessage {
	if (payload.length === 0) {
		return { type: MSG_FAILURE };
	}
	const type = payload[0];
	const rest = payload.subarray(1);
	switch (type) {
		case MSG_REQUEST_IDENTITIES:
			return { type: MSG_REQUEST_IDENTITIES };
		case MSG_SIGN_REQUEST: {
			const reader = new Reader(rest);
			const keyBlob = reader.readString();
			const data = reader.readString();
			const flags = reader.readUInt32();
			return { type: MSG_SIGN_REQUEST, req: { keyBlob, data, flags } };
		}
		default:
			return { type: MSG_FAILURE };
	}
}

export function ed25519PublicKeyBlob(rawPublicKey: Buffer): Buffer {
	return Buffer.concat([encodeString(Buffer.from('ssh-ed25519')), encodeString(rawPublicKey)]);
}

export function ed25519SignatureBlob(privateKey: KeyObject, data: Buffer): Buffer {
	const rawSignature = sign(null, data, privateKey);
	return Buffer.concat([encodeString(Buffer.from('ssh-ed25519')), encodeString(rawSignature)]);
}

export class FrameReader {
	private buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
	}

	next(): Buffer | null {
		if (this.buffer.length < 4) return null;
		const length = this.buffer.readUInt32BE(0);
		if (this.buffer.length < 4 + length) return null;
		const payload = this.buffer.subarray(4, 4 + length);
		this.buffer = this.buffer.subarray(4 + length);
		return payload;
	}
}

function frameMessage(type: number, payload: Buffer): Buffer {
	const frame = Buffer.alloc(4 + 1 + payload.length);
	frame.writeUInt32BE(1 + payload.length, 0);
	frame[4] = type;
	payload.copy(frame, 5);
	return frame;
}

function encodeString(value: Buffer): Buffer {
	const out = Buffer.alloc(4 + value.length);
	out.writeUInt32BE(value.length, 0);
	value.copy(out, 4);
	return out;
}

class Reader {
	private offset = 0;
	constructor(private readonly buf: Buffer) {}

	readString(): Buffer {
		const length = this.buf.readUInt32BE(this.offset);
		this.offset += 4;
		const value = this.buf.subarray(this.offset, this.offset + length);
		this.offset += length;
		return Buffer.from(value);
	}

	readUInt32(): number {
		const value = this.buf.readUInt32BE(this.offset);
		this.offset += 4;
		return value;
	}
}
