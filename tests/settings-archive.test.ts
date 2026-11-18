import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { getLedgerSummary } from '../lib/accounting.js';
import { archiveMember, archivePlatform } from '../server/routes/settings-entities.js';
import { mutateAndSend, type MutationOutcome } from '../server/routes/shared.js';
import type { Database } from '../src/types/billing.js';
import { createRuntime, getCanonicalPersistedFingerprint, type Runtime } from './test-database.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A temporary database seeded from the fake fixtures/demo-database.json (currentMonth 2026/06). */
async function demoRuntime(): Promise<Runtime> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-archive-'));
    directories.push(dataDir);
    const runtime = createRuntime({ rootDir: path.resolve('.'), dataDir, env: { NODE_ENV: 'test', MIGRATE_FROM_JSON: '1' } });
    await runtime.ensureReady();
    return runtime;
}

type SentBody = { success?: boolean; error?: string; data?: Database };
/** Runs an archive through mutateAndSend and runtime.mutateDB, the same write path as the DELETE routes. */
async function archiveThroughRuntime(runtime: Runtime, archive: (db: Database) => MutationOutcome, reason: string) {
    const sent: { status: number; body: SentBody } = { status: 200, body: {} };
    const res = {
        status(code: number) { sent.status = code; return this; },
        json(body: SentBody) { sent.body = body; return this; }
    };
    await mutateAndSend(runtime, res as unknown as Response, archive, { reason });
    return sent;
}

describe('archiving members and platforms', () => {
    it('archives a member and then a platform through the runtime write path', async () => {
        const runtime = await demoRuntime();

        const memberSent = await archiveThroughRuntime(runtime, db => archiveMember(db, 'm_alpha'), 'member.archive');
        expect(memberSent.body).toMatchObject({ success: true });
        expect(memberSent.status).toBe(200);
        expect(runtime.getReadiness()).toEqual({ status: 'ready' });
        const afterMember = (await runtime.readDB())!;
        expect(getCanonicalPersistedFingerprint(memberSent.body.data!)).toBe(getCanonicalPersistedFingerprint(afterMember));
        const member = afterMember.members.find(item => item.id === 'm_alpha');
        expect(member).toEqual({
            id: 'm_alpha', name: 'Member Alpha', priorBalance: 0, customFee: null,
            status: 'archived', archivedAt: expect.stringMatching(ISO_TIMESTAMP), archivedMonth: '2026/06'
        });
        expect(memberSent.body.data!.members.find(item => item.id === 'm_alpha')).toEqual(member);
        expect(afterMember.subscriptions.filter(item => item.exitMonth).map(item => [item.id, item.exitMonth])).toEqual([['s_alpha_video', '2026/05']]);
        expect(afterMember.ledger.entries.at(-1)).toMatchObject({
            type: 'member.archived', entityType: 'member', entityId: 'm_alpha', month: '2026/06',
            payload: { memberId: 'm_alpha', memberName: 'Member Alpha', archivedMonth: '2026/06', closedSubscriptions: 1 }
        });

        const platformSent = await archiveThroughRuntime(runtime, db => archivePlatform(db, 'p_music'), 'platform.archive');
        expect(platformSent.body).toMatchObject({ success: true });
        expect(platformSent.status).toBe(200);
        expect(runtime.getReadiness()).toEqual({ status: 'ready' });
        const afterPlatform = (await runtime.readDB())!;
        expect(getCanonicalPersistedFingerprint(platformSent.body.data!)).toBe(getCanonicalPersistedFingerprint(afterPlatform));
        const platform = afterPlatform.platforms.find(item => item.id === 'p_music');
        expect(platform).toMatchObject({ status: 'archived', archivedAt: expect.stringMatching(ISO_TIMESTAMP), archivedMonth: '2026/06' });
        expect(platformSent.body.data!.platforms.find(item => item.id === 'p_music')).toEqual(platform);
        expect(afterPlatform.subscriptions.filter(item => item.exitMonth).map(item => [item.id, item.exitMonth]).sort()).toEqual([
            ['s_alpha_video', '2026/05'],
            ['s_beta_music', '2026/05']
        ]);
        expect(afterPlatform.ledger.entries.slice(-2).map(entry => [entry.type, entry.entityId])).toEqual([
            ['member.archived', 'm_alpha'],
            ['platform.archived', 'p_music']
        ]);
        expect(afterPlatform.ledger.entries.at(-1)).toMatchObject({
            entityType: 'platform', month: '2026/06',
            payload: { platformId: 'p_music', platformName: 'Shared Music', archivedMonth: '2026/06', closedSubscriptions: 1 }
        });
        expect(getLedgerSummary(afterPlatform).ok).toBe(true);
    });

    it('refuses a second archive and unknown ids without writing', async () => {
        const runtime = await demoRuntime();
        expect((await archiveThroughRuntime(runtime, db => archiveMember(db, 'm_alpha'), 'member.archive')).body).toMatchObject({ success: true });
        expect((await archiveThroughRuntime(runtime, db => archivePlatform(db, 'p_music'), 'platform.archive')).body).toMatchObject({ success: true });
        const settled = getCanonicalPersistedFingerprint((await runtime.readDB())!);

        await expect(archiveThroughRuntime(runtime, db => archiveMember(db, 'm_alpha'), 'member.archive')).rejects.toMatchObject({ status: 409, message: '成員已停用' });
        await expect(archiveThroughRuntime(runtime, db => archivePlatform(db, 'p_music'), 'platform.archive')).rejects.toMatchObject({ status: 409, message: '平台已停用' });
        await expect(archiveThroughRuntime(runtime, db => archiveMember(db, 'm_missing'), 'member.archive')).rejects.toMatchObject({ status: 404, message: '成員不存在' });
        await expect(archiveThroughRuntime(runtime, db => archivePlatform(db, 'p_missing'), 'platform.archive')).rejects.toMatchObject({ status: 404, message: '平台不存在' });
        expect(getCanonicalPersistedFingerprint((await runtime.readDB())!)).toBe(settled);
        expect(runtime.getReadiness()).toEqual({ status: 'ready' });
    });
});
