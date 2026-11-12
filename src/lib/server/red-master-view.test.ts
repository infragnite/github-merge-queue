import { describe, expect, test } from 'vitest';
import { redMasterView } from './red-master-view';

const health = (tried: string[] = []) => ({ sha: '84e7c4849abc', tree: 't', state: 'red' as const, since: 1000, retriedAt: null, tried });
const item = (pr: number, head = `h${pr}`, status = 'queued') => ({ pr_number: pr, head_sha: head, status });

describe('what the queue page says about a red default branch', () => {
	test('nothing while the branch is not red', () => {
		expect(redMasterView({ ...health(), state: 'green' }, [item(1)], 'master')).toBeNull();
		expect(redMasterView(null, [item(1)], 'master')).toBeNull();
	});

	test('PRs not tried in a batch yet: batches run side by side on it', () => {
		expect(redMasterView(health(['1@h1']), [item(1), item(2), item(3, 'h3', 'checking')], 'master')).toEqual({
			sha: '84e7c4849abc',
			since: 1000,
			phase: 'batches',
			left: 2,
			text: 'master fails CI on its own, so no batch can be blamed. Batches of PRs not tried on it yet run side by side until one passes and lands; 2 PRs left. To get back to normal batches, queue a fix with `/mq queue --priority urgent`.'
		});
	});

	test('every PR tried in a batch: each gets one try alone', () => {
		expect(redMasterView(health(['1@h1', '2@h2', '2@h2!']), [item(1), item(2)], 'master')).toMatchObject({
			phase: 'alone',
			left: 1,
			text: 'master fails CI on its own, so no batch can be blamed. Every PR was tried in a batch on it, so each now gets one try alone, in case another PR in its batch broke it; 1 PR left. To get back to normal batches, queue a fix with `/mq queue --priority urgent`.'
		});
	});

	test('every PR tried alone too: the queue waits for a fix', () => {
		expect(redMasterView(health(['1@h1', '1@h1!']), [item(1)], 'main')).toMatchObject({
			phase: 'waiting',
			left: 0,
			text: 'main fails CI on its own, and every PR in the queue failed on it. The queue waits for a push to a PR or a fix: queue one with `/mq queue --priority urgent`.'
		});
	});

	test('a push makes a PR untried again; held and finished PRs are not counted', () => {
		const v = redMasterView(health(['1@old', '1@old!']), [item(1, 'new'), item(2, 'h2', 'conflict'), item(3, 'h3', 'merged')], 'master');
		expect(v).toMatchObject({ phase: 'batches', left: 1 });
	});
});
