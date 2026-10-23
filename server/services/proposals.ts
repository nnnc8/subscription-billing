import type { Client, Transaction } from '@libsql/client';
import { withWriteTransaction } from '../../lib/db.js';
import type { AutomationProposal } from '../../src/types/billing.js';
import { httpError } from '../middleware/error.js';

export function createProposalStore(client: Client) {
    async function storeProposals(items: AutomationProposal[], tx?: Transaction): Promise<void> {
        const write = async (connection: Transaction) => {
            for (const item of items) {
                await connection.execute({
                    sql: 'INSERT INTO automation_proposals (id,status,created_at,updated_at,proposal_json) VALUES (?,?,?,?,?)',
                    args: [item.id, item.status, item.createdAt, new Date().toISOString(), JSON.stringify(item)]
                });
            }
        };
        if (tx) await write(tx);
        else await withWriteTransaction(client, write);
    }
    async function listProposals(): Promise<AutomationProposal[]> {
        return (await client.execute('SELECT proposal_json FROM automation_proposals ORDER BY created_at,id')).rows.map(row => JSON.parse(String(row.proposal_json)) as AutomationProposal);
    }
    async function getProposal(id: string): Promise<AutomationProposal | null> {
        const row = (await client.execute({ sql: 'SELECT proposal_json FROM automation_proposals WHERE id=?', args: [id] })).rows[0];
        return row ? JSON.parse(String(row.proposal_json)) as AutomationProposal : null;
    }
    async function transitionProposal(tx: Transaction, proposal: AutomationProposal): Promise<void> {
        const result = await tx.execute({
            sql: "UPDATE automation_proposals SET status=?,updated_at=?,proposal_json=? WHERE id=? AND status='pending'",
            args: [proposal.status, new Date().toISOString(), JSON.stringify(proposal), proposal.id]
        });
        if (result.rowsAffected !== 1) throw httpError(409, 'Proposal 已變更，請重新整理後再試');
    }
    return { storeProposals, listProposals, getProposal, transitionProposal };
}
