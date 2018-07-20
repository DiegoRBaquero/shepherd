/* eslint-disable class-methods-use-this */
import Octokit from '@octokit/rest';
import fs from 'fs-extra-promise';
import { isEqual } from 'lodash';
import netrc from 'netrc';
import path from 'path';
import simpleGit from 'simple-git/promise';

import { IMigrationContext } from '../migration-context';
import { paginateSearch } from '../util/octokit';
import BaseAdapter, { IRepo } from './base';

class GithubAdapter extends BaseAdapter {
  private octokit: Octokit;
  private branchName: string;
  constructor(migrationContext: IMigrationContext) {
    super(migrationContext);

    this.branchName = migrationContext.migration.spec.id;

    // Authenticate for future GitHub requests
    this.octokit = new Octokit();
    const netrcAuth = netrc();
    this.octokit.authenticate({
      type: 'basic',
      username: netrcAuth['api.github.com'].login,
      password: netrcAuth['api.github.com'].password,
    });
  }

  public async getCandidateRepos(): Promise<IRepo[]> {
    const searchResults = await paginateSearch(this.octokit.search.code)({
      q: this.migrationContext.migration.spec.search_query,
    });
    return searchResults.map((r: any) => this.parseSelectedRepo(r.repository.full_name));
  }

  public parseSelectedRepo(repo: string): IRepo {
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new Error(`Could not parse repo "${repo}"`);
    }
    return { owner, name };
  }

  public reposEqual(repo1: IRepo, repo2: IRepo): boolean {
    return isEqual(repo1, repo2);
  }

  public formatRepo({ owner, name }: IRepo): string {
    return `${owner}/${name}`;
  }

  public async checkoutRepo(repo: IRepo): Promise<void> {
    const repoPath = `git@github.com:${repo.owner}/${repo.name}.git`;
    const localPath = await this.getRepoDir(repo);

    if (await fs.existsAsync(localPath) && await simpleGit(localPath).checkIsRepo()) {
      // Repo already exists; just fetch
      await simpleGit(localPath).fetch('origin');
    } else {
      await simpleGit().clone(repoPath, localPath);
    }

    // We'll immediately create and switch to a new branch
    try {
      await simpleGit(localPath).checkoutLocalBranch(this.branchName);
    } catch (e) {
      // This branch probably already exists; we'll just switch to it
      // to make sure we're on the right branch for the commit phase
      await simpleGit(localPath).checkout(this.branchName);
    }
  }

  public async commitRepo(repo: IRepo): Promise<void> {
    const { migration: { spec } } = this.migrationContext;
    const localPath = await this.getRepoDir(repo);
    await simpleGit(localPath).commit(`Shepherd: ${spec.title}`, './*');
  }

  public async resetRepo(repo: IRepo): Promise<void> {
    const localPath = await this.getRepoDir(repo);
    await simpleGit(localPath).reset('hard');
    await simpleGit(localPath).clean('f', ['-d']);
  }

  public async pushRepo(repo: IRepo): Promise<void> {
    const localPath = await this.getRepoDir(repo);
    await simpleGit(localPath).push('origin', 'HEAD', { '-f': null, '-d': null });
  }

  public async prRepo(repo: IRepo, message: string): Promise<void> {
    const { migration: { spec } } = this.migrationContext;
    const { owner, name } = repo;
    // We need to figure out the "default" branch to create a pull request
    const githubReop = await this.octokit.repos.get({
      owner,
      repo: name,
    });
    await this.octokit.pullRequests.create({
      owner,
      repo: name,
      head: this.branchName,
      base: githubReop.data.default_branch,
      title: spec.title,
      body: message,
    });
  }

  public async getRepoDir(repo: IRepo): Promise<string> {
    return path.join(this.migrationContext.migration.workingDirectory, 'repos', repo.owner, repo.name);
  }

  public async getDataDir(repo: IRepo): Promise<string> {
    return path.join(this.migrationContext.migration.workingDirectory, 'data', repo.owner, repo.name);
  }
}

export default GithubAdapter;
