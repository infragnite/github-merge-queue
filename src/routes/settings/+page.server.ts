import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Repositories are added on the dashboard now, and removed from their own queue settings.
export const load: PageServerLoad = () => redirect(301, '/');
