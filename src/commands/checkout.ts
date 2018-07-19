import fs from 'fs-extra';

import BaseAdapter, { IRepo } from '../adapters/base';
import { IMigrationContext } from '../migration-context';
import executeSteps from '../util/execute-steps';
import forEachRepo from '../util/for-each-repo';
import { updateRepoList } from '../util/persisted-data';

const removeRepoDirectories = async (adapter: BaseAdapter, repo: IRepo) => {
  fs.removeSync(await adapter.getRepoDir(repo));
  fs.removeSync(await adapter.getDataDir(repo));
};

export default async (context: IMigrationContext) => {
  const {
    migration: { selectedRepos },
    adapter,
    logger,
  } = context;

  let repos;
  if (selectedRepos) {
    logger.info(`Using ${selectedRepos.length} selected repos`);
    repos = selectedRepos;
  } else {
    const spinner = logger.spinner('Loading candidate repos from GitHub');
    repos = await adapter.getCandidateRepos();
    spinner.succeed(`Loaded ${repos.length} repos`);
  }

  context.migration.repos = repos;

  const checkedOutRepos: IRepo[] = [];
  const discardedRepos: IRepo[] = [];

  forEachRepo(context, async (repo) => {
    const spinner = logger.spinner('Checking out repo');
    try {
      await adapter.checkoutRepo(repo);
      spinner.succeed('Checked out repo');
    } catch (e) {
      logger.warn(e);
      spinner.fail('Failed to check out repo, skipping');
      return;
    }

    logger.info('> Running should_migrate steps');
    const stepsResults = await executeSteps(context, repo, 'should_migrate');
    if (!stepsResults.succeeded) {
      discardedRepos.push(repo);
      removeRepoDirectories(adapter, repo);
      logger.spinner('Error running should_migrate steps; skipping repo').fail();
    } else {
      logger.spinner('Completed all should_migrate steps successfully').succeed();

      logger.info('> Running post_checkout steps');
      const postCheckoutStepsResults = await executeSteps(context, repo, 'post_checkout');
      if (!postCheckoutStepsResults.succeeded) {
        discardedRepos.push(repo);
        removeRepoDirectories(adapter, repo);
        logger.spinner('Error running post_checkout steps; skipping repo').fail();
      } else {
        logger.spinner('Completed all post_checkout steps successfully').succeed();
        checkedOutRepos.push(repo);
      }
    }
  });

  // We'll persist this list of repos for use in future steps
  updateRepoList(context, checkedOutRepos, discardedRepos);
};
