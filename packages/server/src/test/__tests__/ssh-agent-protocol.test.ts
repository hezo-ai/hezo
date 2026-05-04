import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	decodeMessage,
	ed25519PublicKeyBlob,
	ed25519SignatureBlob,
	encodeFailure,
	encodeIdentitiesAnswer,
	encodeSignResponse,
	FrameReader,
	MSG_FAILURE,
	MSG_REQUEST_IDENTITIES,
	MSG_SIGN_REQUEST,
	MSG_SIGN_RESPONSE,
} from '../../services/ssh-agent/protocol';

describe('SSH agent protocol', () => {
	it('encodes IDENTITIES_ANSWER with zero keys', () => {
		const out = encodeIdentitiesAnswer([]);
		expect(out.readUInt32BE(0)).toBe(5);
		expect(out[4]).toBe(12);
		expect(out.readUInt32BE(5)).toBe(0);
	});

	it('encodes IDENTITIES_ANSWER with one key', () => {
		const blob = Buffer.from([0xaa, 0xbb, 0xcc]);
		const out = encodeIdentitiesAnswer([{ keyBlob: blob, comment: 'hi' }]);
		expect(out[4]).toBe(12);
		expect(out.readUInt32BE(5)).toBe(1);
		expect(out.readUInt32BE(9)).toBe(blob.length);
		expect(out.subarray(13, 13 + blob.length)).toEqual(blob);
	});

	it('encodes SIGN_RESPONSE wrapping the signature blob as a string', () => {
		const sigBlob = Buffer.from([1, 2, 3, 4]);
		const out = encodeSignResponse(sigBlob);
		expect(out[4]).toBe(MSG_SIGN_RESPONSE);
		expect(out.readUInt32BE(5)).toBe(sigBlob.length);
		expect(out.subarray(9, 9 + sigBlob.length)).toEqual(sigBlob);
	});

	it('encodes FAILURE as a single-byte payload', () => {
		const out = encodeFailure();
		expect(out.readUInt32BE(0)).toBe(1);
		expect(out[4]).toBe(MSG_FAILURE);
	});

	it('decodes REQUEST_IDENTITIES', () => {
		const decoded = decodeMessage(Buffer.from([MSG_REQUEST_IDENTITIES]));
		expect(decoded.type).toBe(MSG_REQUEST_IDENTITIES);
	});

	it('decodes SIGN_REQUEST with key blob, data, and flags', () => {
		const keyBlob = Buffer.from([0x10, 0x20, 0x30]);
		const data = Buffer.from('hello world');
		const flags = 0;
		const payload = Buffer.concat([
			Buffer.from([MSG_SIGN_REQUEST]),
			lenPrefixed(keyBlob),
			lenPrefixed(data),
			uint32(flags),
		]);
		const decoded = decodeMessage(payload);
		if (decoded.type !== MSG_SIGN_REQUEST) throw new Error('wrong type');
		expect(decoded.req.keyBlob).toEqual(keyBlob);
		expect(decoded.req.data).toEqual(data);
		expect(decoded.req.flags).toBe(flags);
	});

	it('decodes unknown messages as FAILURE', () => {
		const decoded = decodeMessage(Buffer.from([99]));
		expect(decoded.type).toBe(MSG_FAILURE);
	});
});

describe('Ed25519 helpers', () => {
	it('builds a public key blob with ssh-ed25519 prefix', () => {
		const raw = Buffer.alloc(32, 7);
		const blob = ed25519PublicKeyBlob(raw);
		expect(blob.readUInt32BE(0)).toBe('ssh-ed25519'.length);
		expect(blob.subarray(4, 4 + 11).toString()).toBe('ssh-ed25519');
		expect(blob.readUInt32BE(15)).toBe(32);
		expect(blob.subarray(19)).toEqual(raw);
	});

	it('signs data and produces a signature blob with ssh-ed25519 prefix and 64-byte sig', () => {
		const { privateKey } = generateKeyPairSync('ed25519');
		const data = Buffer.from('sign me');
		const sigBlob = ed25519SignatureBlob(privateKey, data);
		expect(sigBlob.readUInt32BE(0)).toBe('ssh-ed25519'.length);
		expect(sigBlob.subarray(4, 4 + 11).toString()).toBe('ssh-ed25519');
		expect(sigBlob.readUInt32BE(15)).toBe(64);
		expect(sigBlob.subarray(19).length).toBe(64);
	});
});

describe('FrameReader', () => {
	it('returns null when fewer than 4 bytes are buffered', () => {
		const r = new FrameReader();
		r.push(Buffer.from([0, 0, 0]));
		expect(r.next()).toBeNull();
	});

	it('returns null when length is set but body is incomplete', () => {
		const r = new FrameReader();
		r.push(Buffer.from([0, 0, 0, 5, 1, 2]));
		expect(r.next()).toBeNull();
	});

	it('returns the payload when a full frame is buffered', () => {
		const r = new FrameReader();
		r.push(Buffer.from([0, 0, 0, 3, 11, 99, 50]));
		expect(r.next()).toEqual(Buffer.from([11, 99, 50]));
	});

	it('handles multiple frames in one chunk', () => {
		const r = new FrameReader();
		const f1 = Buffer.from([0, 0, 0, 1, 11]);
		const f2 = Buffer.from([0, 0, 0, 1, 12]);
		r.push(Buffer.concat([f1, f2]));
		expect(r.next()).toEqual(Buffer.from([11]));
		expect(r.next()).toEqual(Buffer.from([12]));
		expect(r.next()).toBeNull();
	});

	it('handles a frame split across pushes', () => {
		const r = new FrameReader();
		r.push(Buffer.from([0, 0, 0, 4, 1, 2]));
		expect(r.next()).toBeNull();
		r.push(Buffer.from([3, 4]));
		expect(r.next()).toEqual(Buffer.from([1, 2, 3, 4]));
	});
});

function lenPrefixed(buf: Buffer): Buffer {
	const out = Buffer.alloc(4 + buf.length);
	out.writeUInt32BE(buf.length, 0);
	buf.copy(out, 4);
	return out;
}

function uint32(value: number): Buffer {
	const out = Buffer.alloc(4);
	out.writeUInt32BE(value, 0);
	return out;
}
