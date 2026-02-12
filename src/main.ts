/**
 * @fileoverview Main entry point for the Docker Compose Cache GitHub Action.
 * Orchestrates service processing, cache operations, and action outputs.
 */

import * as core from '@actions/core';

import {
  buildProcessedImageList,
  calculateActionSummary,
  createActionSummary,
  logActionCompletion,
  setActionOutputs,
  type TimedServiceResult,
} from './action-outputs';
import { formatTimeBetween } from './date-utils';
import type { ContainerRuntime } from './docker-command';
import { getComposeFilePathsToProcess, getComposeServicesFromFiles } from './docker-compose-file';
import { processService } from './docker-compose-service-processing';

/**
 * Default cache key prefix when none is provided.
 */
const DEFAULT_CACHE_KEY_PREFIX = 'docker-compose-image';

/**
 * Configuration for action inputs.
 */
type ActionConfig = {
  readonly composeFilePaths: ReadonlyArray<string>;
  readonly excludeImageNames: ReadonlyArray<string>;
  readonly additionalImages: ReadonlyArray<string>;
  readonly cacheKeyPrefix: string;
  readonly skipDigestVerification: boolean;
  readonly forceRefresh: boolean;
  readonly containerRuntime: string;
};

/**
 * Gets the skip digest verification setting from action inputs.
 * Handles both the new 'skip-digest-verification' and deprecated 'skip-latest-check' inputs.
 * If the deprecated input is used, a warning is logged.
 *
 * @returns boolean indicating whether to skip digest verification
 */
function getSkipDigestVerification(): boolean {
  // Check new input first
  const skipDigestVerificationInput = core.getInput('skip-digest-verification');
  if (skipDigestVerificationInput !== '') {
    return core.getBooleanInput('skip-digest-verification');
  }

  // Fall back to deprecated input
  const skipLatestCheckInput = core.getInput('skip-latest-check');
  if (skipLatestCheckInput !== '') {
    core.warning(
      "The 'skip-latest-check' input is deprecated and will be removed in a future major version. " +
        "Please use 'skip-digest-verification' instead."
    );
    return core.getBooleanInput('skip-latest-check');
  }

  return false;
}

/**
 * Gets action configuration from GitHub Actions environment.
 */
function getActionConfig(): ActionConfig {
  return {
    composeFilePaths: core.getMultilineInput('compose-files'),
    excludeImageNames: core.getMultilineInput('exclude-images'),
    additionalImages: core.getMultilineInput('additional-images'),
    cacheKeyPrefix: core.getInput('cache-key-prefix') || DEFAULT_CACHE_KEY_PREFIX,
    skipDigestVerification: getSkipDigestVerification(),
    forceRefresh: core.getBooleanInput('force-refresh'),
    containerRuntime: core.getInput('container-runtime') || 'docker',
  };
}

/**
 * Main function that runs the GitHub Action.
 * Handles all orchestration, output, and error management for the action.
 */
export async function run(): Promise<void> {
  const actionStartTime = performance.now();

  try {
    const actionConfig = getActionConfig();

    const discoveredComposeFiles = getComposeFilePathsToProcess(actionConfig.composeFilePaths);
    const targetServices = getComposeServicesFromFiles(discoveredComposeFiles, actionConfig.excludeImageNames);
    const targetImages = [...targetServices, ...actionConfig.additionalImages.map((image) => ({ image }))];

    if (targetImages.length === 0) {
      core.info('No Docker services found in compose files or all services were excluded');
      setActionOutputs(false, []);
      return;
    }

    core.info(`Found ${targetImages.length} images to cache`);

    if (actionConfig.forceRefresh) {
      core.info('Force refresh enabled - ignoring existing cache');
    }
    let containerRuntime = actionConfig.containerRuntime as ContainerRuntime;
    if (!['docker', 'podman'].includes(actionConfig.containerRuntime)) {
      core.warning(
        `Unsupported container runtime '${actionConfig.containerRuntime}' specified. Defaulting to 'docker'.`
      );
      containerRuntime = 'docker';
    }

    // Process all services concurrently
    const serviceProcessingResults: readonly TimedServiceResult[] = await Promise.all(
      targetImages.map(async (currentImage) => {
        const serviceStartTime = performance.now();
        const serviceResult = await processService(
          containerRuntime,
          currentImage,
          actionConfig.cacheKeyPrefix,
          actionConfig.skipDigestVerification,
          actionConfig.forceRefresh
        );
        const serviceEndTime = performance.now();

        return {
          ...serviceResult,
          processingDuration: serviceEndTime - serviceStartTime,
          humanReadableDuration: formatTimeBetween(serviceStartTime, serviceEndTime),
        };
      })
    );

    const actionEndTime = performance.now();
    const executionTimeMs = actionEndTime - actionStartTime;

    const summary = calculateActionSummary(serviceProcessingResults, executionTimeMs);
    const imageListOutput = buildProcessedImageList(serviceProcessingResults);

    setActionOutputs(summary.allServicesFromCache, imageListOutput);
    createActionSummary(serviceProcessingResults, summary, discoveredComposeFiles, actionConfig.skipDigestVerification);
    logActionCompletion(summary);
  } catch (executionError) {
    if (executionError instanceof Error) {
      core.setFailed(executionError.message);
    } else {
      core.setFailed('Unknown error occurred');
    }
  }
}

// Execute the action
run();
