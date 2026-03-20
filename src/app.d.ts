declare global {
	namespace App {
		interface Locals {
			user: {
				id: number;
				login: string;
				name: string | null;
				avatarUrl: string | null;
			} | null;
		}
	}
}

export {};
