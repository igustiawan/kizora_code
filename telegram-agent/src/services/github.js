import { Octokit } from '@octokit/rest';

export function createOctokit(token) {
  return new Octokit({ auth: token });
}

/** Ambil username GitHub untuk validasi token. */
export async function getAuthenticatedLogin(token) {
  const octokit = createOctokit(token);
  const { data } = await octokit.users.getAuthenticated();
  return data.login;
}

/**
 * List repo yang bisa diakses token, urut dari yang terakhir di-update.
 * @returns {Promise<Array<{full_name:string, private:boolean, default_branch:string, language:string|null, description:string}>>}
 */
export async function listRepos(token, limit = 30) {
  const octokit = createOctokit(token);
  const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    sort: 'updated',
    per_page: 100
  });
  return repos.slice(0, limit).map((r) => ({
    full_name: r.full_name,
    private: r.private,
    default_branch: r.default_branch,
    language: r.language,
    description: r.description || ''
  }));
}
