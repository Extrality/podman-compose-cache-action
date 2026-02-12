/**
 * @fileoverview Docker command execution utilities.
 * Provides functions for Docker image operations including pull, inspect, save, and load.
 */

import * as core from '@actions/core';
import * as exec from '@actions/exec';

/**
 * Docker image metadata from inspect command.
 * Contains essential information about a Docker image.
 */
export type DockerImageMetadata = {
  readonly Size: number;
  // unused fields:
  //   readonly Id: string;
  //   readonly Architecture: string;
  //   readonly Os: string;
  //   readonly Variant?: string;
  //   readonly RepoTags: readonly string[];
  //   readonly RepoDigests: readonly string[];
  //   readonly Created: string;
};

/**
 * Docker image manifest information.
 * Contains essential manifest data for an image.
 */
export type DockerImageManifest = {
  readonly digest?: string;
  // unused fields:
  //   readonly schemaVersion?: number;
  //   readonly mediaType?: string;
  //   readonly [key: string]: unknown;
};

export type ContainerRuntime = 'docker' | 'podman';

/**
 * Executes a Docker command and logs execution time.
 *
 * @param cmd - Array of path to the executable and command arguments.
 * @param options - Execution options.
 * @returns Promise resolving to object containing exit code, stdout, and stderr.
 */
async function executeCommand(
  cmd: readonly string[],
  options: exec.ExecOptions
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const fullCommand = cmd.join(' ');
  // biome-ignore lint/style/noNonNullAssertion: We know the first element is the path to the executable
  const path = cmd[0]!;
  const args = cmd.slice(1);

  // Log command execution
  core.info(`Executing: ${fullCommand}`);

  // Record start time
  const executionStartTime = performance.now();

  // Note: This function requires controlled mutation for stream collection
  // The mutation is localized to this function and the arrays are treated as immutable elsewhere
  const commandOutputBuffer: {
    stdout: readonly string[];
    stderr: readonly string[];
  } = {
    stdout: [] as readonly string[],
    stderr: [] as readonly string[],
  };

  // Create a new options object with our stdout/stderr listeners
  const execOptionsWithCapture: exec.ExecOptions = {
    ...options,
    listeners: {
      ...options.listeners,
      stdout: (data: Buffer) => {
        const outputChunk = data.toString();
        // Controlled mutation: creating new immutable array each time
        commandOutputBuffer.stdout = [...commandOutputBuffer.stdout, outputChunk] as const;
        // If the original options had a stdout listener, call it
        if (options.listeners?.stdout) {
          options.listeners.stdout(data);
        }
      },
      stderr: (data: Buffer) => {
        const outputChunk = data.toString();
        // Controlled mutation: creating new immutable array each time
        commandOutputBuffer.stderr = [...commandOutputBuffer.stderr, outputChunk] as const;
        // If the original options had a stderr listener, call it
        if (options.listeners?.stderr) {
          options.listeners.stderr(data);
        }
      },
    },
  };

  try {
    // Execute the command
    const exitCode = await exec.exec(path, [...args], execOptionsWithCapture);

    // Calculate and log execution time
    const executionEndTime = performance.now();
    const executionTimeMs = Math.round(executionEndTime - executionStartTime);
    core.info(`Command completed in ${executionTimeMs}ms: ${fullCommand}`);

    // Join all chunks to create the complete output strings
    const stdout = commandOutputBuffer.stdout.join('');
    const stderr = commandOutputBuffer.stderr.join('');

    return { exitCode, stdout, stderr };
  } catch (error) {
    // Log execution failure
    const executionEndTime = performance.now();
    const executionTimeMs = Math.round(executionEndTime - executionStartTime);
    core.error(`Command failed after ${executionTimeMs}ms: ${fullCommand}`);
    throw error;
  }
}

/**
 * Pulls a Docker image, optionally for a specific platform.
 *
 * @param imageName - Docker image name to pull.
 * @param platform - Optional platform string (e.g., 'linux/amd64').
 * @returns Promise resolving to boolean indicating success or failure.
 */
export async function pullImage(
  containerRuntime: ContainerRuntime,
  imageName: string,
  platform: string | undefined
): Promise<boolean> {
  try {
    const execOptions = { ignoreReturnCode: true } as const;

    const pullCommand = [containerRuntime, 'pull', imageName];
    if (platform) {
      pullCommand.push('--platform', platform);
      core.info(`Pulling image ${imageName} for platform ${platform}`);
    }

    // Execute docker pull command
    const { exitCode, stderr } = await executeCommand(pullCommand, execOptions);

    if (exitCode !== 0) {
      core.warning(`Failed to pull image ${imageName}${platform ? ` for platform ${platform}` : ''}: ${stderr}`);
      return false;
    }

    return true;
  } catch (error) {
    core.warning(`Failed to pull image ${imageName}${platform ? ` for platform ${platform}` : ''}: ${error}`);
    return false;
  }
}

/**
 * Inspects a remote Docker image and returns its manifest information.
 *
 * Uses 'docker buildx imagetools inspect' to retrieve detailed manifest information.
 * The returned manifest can be either a single platform manifest or a multi-platform manifest list.
 *
 * @param imageName - Docker image name with optional tag.
 * @returns Promise resolving to DockerManifest object or undefined on failure.
 */
export async function inspectImageRemote(imageName: string): Promise<DockerImageManifest | undefined> {
  try {
    const execOptions: exec.ExecOptions = {
      ignoreReturnCode: true,
    };

    // Still use docker buildx to inspect remote images since it's installed by default on github hosted runners.
    // Otherwise we would have to install skopeo
    const cmd = ['docker', 'buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', imageName];
    const { exitCode, stdout, stderr } = await executeCommand(cmd, execOptions);

    if (exitCode !== 0) {
      core.warning(`Failed to inspect manifest for ${imageName}: ${stderr}`);
      return undefined;
    }

    try {
      // Parse the JSON output to extract the manifest
      const manifest = JSON.parse(stdout.trim()) as DockerImageManifest;
      return manifest;
    } catch (manifestJsonParseError) {
      core.warning(`Failed to parse manifest JSON for ${imageName}: ${manifestJsonParseError}`);
      return undefined;
    }
  } catch (error) {
    core.warning(`Error inspecting manifest for ${imageName}: ${error}`);
    return undefined;
  }
}

/**
 * Inspects a local Docker image and returns detailed information.
 *
 * Uses 'docker inspect' to retrieve comprehensive information about an image.
 * Contains details about the image's configuration, layers, size, architecture, etc.
 *
 * Note: Images pulled from remote repositories and images loaded via docker load
 * may have differences in the following information:
 * - RepoTags: May be empty for loaded images
 * - RepoDigests: May be empty for loaded images
 * - Metadata.LastTagTime: May be empty for loaded images
 * - GraphDriver.Data: May have different paths depending on the environment
 *
 * @param imageName - Docker image name with optional tag.
 * @returns Promise resolving to DockerInspectInfo object or undefined on failure.
 */
export async function inspectImageLocal(
  containerRuntime: ContainerRuntime,
  imageName: string
): Promise<DockerImageMetadata | undefined> {
  try {
    const execOptions: exec.ExecOptions = {
      ignoreReturnCode: true,
    };
    const cmd = [containerRuntime, 'inspect', '--format', '{{json .}}', imageName];

    // Execute docker inspect command to get detailed image information
    const { exitCode, stdout, stderr } = await executeCommand(cmd, execOptions);

    if (exitCode !== 0) {
      core.warning(`Failed to inspect image ${imageName}: ${stderr}`);
      return undefined;
    }

    try {
      // Parse the JSON output to extract the image information
      const imageMetadata = JSON.parse(stdout.trim()) as DockerImageMetadata;
      return imageMetadata;
    } catch (inspectJsonParseError) {
      core.warning(`Failed to parse inspect JSON for ${imageName}: ${inspectJsonParseError}`);
      return undefined;
    }
  } catch (error) {
    core.warning(`Error inspecting image ${imageName}: ${error}`);
    return undefined;
  }
}

/**
 * Saves Docker image to a tar file.
 *
 * @param imageName - Docker image name to save.
 * @param outputPath - File path where the tar file should be created.
 * @returns Promise resolving to boolean indicating success or failure.
 */
export async function saveImageToTar(
  containerRuntime: ContainerRuntime,
  imageName: string,
  outputPath: string
): Promise<boolean> {
  try {
    const execOptions = { ignoreReturnCode: true } as const;
    // Execute docker save command to create a tar archive of the image
    const cmd = [containerRuntime, 'save', '-o', outputPath, imageName];
    if (containerRuntime === 'podman') {
      // oci-archive supports more formats like zstd compressed layers
      cmd.push('--format', 'oci-archive');
    }
    const { exitCode, stderr } = await executeCommand(cmd, execOptions);

    if (exitCode !== 0) {
      core.warning(`Failed to save image ${imageName} to ${outputPath}: ${stderr}`);
      return false;
    }

    return true;
  } catch (error) {
    core.warning(`Failed to save image ${imageName}: ${error}`);
    return false;
  }
}

/**
 * Loads Docker image from a tar file.
 *
 * @param tarPath - Path to the tar file containing the Docker image.
 * @returns Promise resolving to boolean indicating success or failure.
 */
export async function loadImageFromTar(containerRuntime: ContainerRuntime, tarPath: string): Promise<boolean> {
  try {
    const execOptions = { ignoreReturnCode: true } as const;
    // Execute docker load command to restore image from tar archive
    const { exitCode, stderr } = await executeCommand([containerRuntime, 'load', '-i', tarPath], execOptions);

    if (exitCode !== 0) {
      core.warning(`Failed to load image from ${tarPath}: ${stderr}`);
      return false;
    }

    return true;
  } catch (error) {
    core.warning(`Failed to load image from ${tarPath}: ${error}`);
    return false;
  }
}
