export interface User {
	id: number;
	github_id: number;
	login: string;
	name: string | null;
	avatar_url: string | null;
	created_at: string;
}

export interface Repo {
	id: number;
	owner: string;
	name: string;
	default_branch: string;
	webhook_secret: string | null;
	added_by: number;
	created_at: string;
}

export interface RepoWithStats extends Repo {
	queue_count: number;
	current_status: string | null;
}

export interface QueueItem {
	id: number;
	repo_id: number;
	pr_number: number;
	pr_title: string;
	pr_url: string;
	author_login: string;
	author_avatar: string;
	head_sha: string | null;
	status: 'queued' | 'updating' | 'checking' | 'merging' | 'merged' | 'failed' | 'cancelled';
	position: number;
	error_message: string | null;
	queued_by: string;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
}

export interface HistoryItem {
	id: number;
	repo_id: number;
	pr_number: number;
	pr_title: string;
	pr_url: string;
	author_login: string;
	merged_sha: string | null;
	status: 'merged' | 'failed';
	error_message: string | null;
	queued_at: string | null;
	completed_at: string;
	repo_owner: string;
	repo_name: string;
}

export interface OpenPR {
	number: number;
	title: string;
	url: string;
	author: string;
	authorAvatar: string;
	draft: boolean;
}
