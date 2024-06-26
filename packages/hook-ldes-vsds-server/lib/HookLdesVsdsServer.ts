import Path from "path";
import {
  Hook,
  ICleanTargets,
  IHookStartOptions,
  ITaskContext,
  ProcessHandler,
  ProcessHandlerComposite,
  StaticDockerResourceConstraints,
} from "jbr";
import { glob } from "glob";

import { readFile, writeFile } from "fs/promises";
import { Configs, DockerConfigs } from "./Configs";

/**
 * A hook instance for a Comunica-based SPARQL endpoint.
 */
export class HookLdesVsdsServer implements Hook {
  public readonly dockerfileClient: string;
  public readonly auxiliaryFiles: string[];
  public readonly clientPort: number;
  public readonly env: string[];
  public readonly pageSize: number;
  public readonly dataGlob: string[];
  public readonly ingestPort: number;
  public readonly networkName?: string;
  public readonly imageName?: string;
  public readonly quiet?: boolean;

  public constructor(
    dockerfileClient: string,
    // auxiliaryFiles from templates, will be mapped to input
    pageSize: number,
    auxiliaryFiles: string[],
    clientPort: number,
    env: string[],
    dataGlob: string[],
    ingestPort: number,
    networkName?: string,
    quiet?: boolean,
  ) {
    this.pageSize = pageSize;
    console.log("HookLdesVsdsServer started");
    this.dockerfileClient = dockerfileClient;
    this.auxiliaryFiles = auxiliaryFiles;
    this.clientPort = clientPort;
    this.env = env;
    this.dataGlob = dataGlob;
    this.ingestPort = ingestPort;
    this.networkName = networkName;
    this.quiet = quiet;
  }

  private clientFile(context: ITaskContext, file: string): string {
    const out = Path.join(context.experimentPaths.input, file);
    return out;
  }

  public getDockerImageName(context: ITaskContext, type: string): string {
    return context.docker.imageBuilder.getImageName(
      context,
      `ldes-vsds-${type}`,
    );
  }

  public async prepare(
    context: ITaskContext,
    _forceOverwriteGenerated: boolean,
  ): Promise<void> {
    console.log("Prepare vsds server");
    for (let config of Object.values(Configs)) {
      console.log("Writing file to", config.name);
      await writeFile(
        this.clientFile(context, config.name),
        config.config(this.pageSize),
        { encoding: "utf-8" },
      );
    }

    for (let config of Object.values(DockerConfigs)) {
      console.log("Pulling", config.tag);
      await context.docker.imagePuller.pull({
        repoTag: config.tag,
      });
    }
    console.log("Prepare done");
  }

  public async start(
    context: ITaskContext,
    options?: IHookStartOptions,
  ): Promise<ProcessHandler> {
    // Create shared network
    const networkHandler = options?.docker?.network
      ? undefined
      : await context.docker.networkCreator.find(
          this.networkName ||
            this.getDockerImageName(
              context,
              this.getDockerImageName(context, "network"),
            ),
          true,
        );

    console.log("Attaching to network ", this.networkName, networkHandler);
    const network = options?.docker?.network || networkHandler!.network.id;

    console.log("Starting mongo container");
    const mongo = await context.docker.containerCreator.start({
      containerName: DockerConfigs.mongo.container,
      imageName: DockerConfigs.mongo.tag,
      resourceConstraints: new StaticDockerResourceConstraints(
        {},
        {
          limit: "8g",
        },
      ),
      hostConfig: {
        NetworkMode: network,
      },
      logFilePath: Path.join(
        context.experimentPaths.output,
        "logs",
        "ldes-vsds-mongo.txt",
      ),
      statsFilePath: Path.join(
        context.experimentPaths.output,
        "stats-ldes-vsds-mongo.csv",
      ),
    });

    await new Promise((res) => setTimeout(res, 5000));
    console.log("Starting server");
    const server = await context.docker.containerCreator.start({
      containerName: DockerConfigs.server.container,
      imageName: DockerConfigs.server.tag,
      hostConfig: {
        NetworkMode: network,
        Binds: [
          `${this.clientFile(
            context,
            Configs.server.name,
          )}:/config/application.yml`,
          `${this.clientFile(context, Configs.bearBRq.name)}:/ldio/bear-b.rq`,
        ],
        PortBindings: {
          "8080/tcp": [{ HostPort: `8080` }],
        },
      },
      logFilePath: Path.join(
        context.experimentPaths.output,
        "logs",
        "ldes-vsds-mongo.txt",
      ),
      statsFilePath: Path.join(
        context.experimentPaths.output,
        "stats-ldes-vsds-mongo.csv",
      ),
      exposedPorts: ["8080/tcp"],
    });

    const serverStats = await server.startCollectingStats();

    console.log("Starting pipeline");
    const pipeline = await context.docker.containerCreator.start({
      containerName: DockerConfigs.orchestrator.container,
      imageName: DockerConfigs.orchestrator.tag,
      // resourceConstraints: this.,
      logFilePath: Path.join(
        context.experimentPaths.output,
        "logs",
        "ldes-pipeline-log.txt",
      ),
      hostConfig: {
        NetworkMode: network,
        Binds: [
          `${this.clientFile(
            context,
            Configs.pipeline.name,
          )}:/config/application.yml`,
          `${this.clientFile(context, Configs.bearBRq.name)}:/ldio/bear-b.rq`,
        ],
        PortBindings: {
          "8080/tcp": [{ HostPort: `8081` }],
        },
      },
      env: [
        "SPRING_CONFIG_NAME=application",
        "SPRING_CONFIG_LOCATION=/config/",
      ],
      statsFilePath: Path.join(
        context.experimentPaths.output,
        "stats-ldes-pipeline.csv",
      ),
      exposedPorts: ["8080/tcp"],
    });

    server.outputStream.pipe(process.stdout);
    pipeline.outputStream.pipe(process.stdout);

    const pipelineStats = await pipeline.startCollectingStats();
    await new Promise((res) => setTimeout(res, 300000));

    console.log("Starting ingest");
    await this.ingest();

    serverStats();
    pipelineStats();

    if (!this.quiet) {
      server.outputStream.pipe(process.stdout);
    }

    console.log("Ingestion complete");
    await new Promise((res) => setTimeout(res, 4000));

    return new ProcessHandlerComposite([server, mongo, pipeline]);
  }

  private async ingest() {
    // Create eventstream
    //

    let resp = await fetch("http://localhost:8080/admin/api/v1/eventstreams", {
      headers: { "Content-Type": "text/turtle" },
      method: "POST",
      body: Configs.eventStreamConfig.config(),
    });
    if (!resp.ok) {
      console.log("Fetch failed :(");
      throw "NOT OKAY, OKAY? Evenstream creation";
    }

    resp = await fetch(
      "http://localhost:8080/admin/api/v1/eventstreams/ldes/views",
      {
        headers: { "Content-Type": "text/turtle" },
        method: "POST",
        body: Configs.viewConfig.config(this.pageSize),
      },
    );

    if (!resp.ok) {
      throw "NOT OKAY, OKAY? View creation";
    }

    const dataFiles = glob.globSync
      ? glob.globSync(this.dataGlob, { nodir: true })
      : glob.sync(this.dataGlob, { nodir: true });
    dataFiles.sort();
    let i = 0;

    for (let file of dataFiles) {
      i += 1;
      console.log("ingesting", file, `(${i}/${dataFiles.length})`);
      let content = await readFile(file, { encoding: "utf8" });

      const push = await fetch("http://localhost:8081/bear-b-pipeline-in", {
        headers: {
          "Content-Type": "text/turtle",
        },
        method: "POST",
        body: content,
      });
      if (!push.ok) {
        if (!resp.ok) {
          throw "NOT OKAY, OKAY? Data ingest " + i;
        }
      }

      await new Promise((res) => setTimeout(res, 500));
    }
  }

  public async clean(
    context: ITaskContext,
    cleanTargets: ICleanTargets,
  ): Promise<void> {
    console.log("Cleaning", cleanTargets);
    if (cleanTargets.docker) {
      await context.docker.networkCreator.remove(
        this.networkName || this.getDockerImageName(context, "network"),
      );
      for (let config of Object.values(DockerConfigs)) {
        await context.docker.containerCreator.remove(config.container);
      }
    }
  }
}
