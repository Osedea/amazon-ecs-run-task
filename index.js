const path = require('path');
const core = require('@actions/core');
const aws = require('aws-sdk');
const yaml = require('yaml');
const fs = require('fs');

// Attributes that are returned by DescribeTaskDefinition, but are not valid RegisterTaskDefinition inputs
const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
  'compatibilities',
  'taskDefinitionArn',
  'requiresAttributes',
  'revision',
  'status',
  'registeredAt',
  'deregisteredAt',
  'registeredBy'
];

const WAIT_DEFAULT_DELAY_SEC = 5;
const MAX_WAIT_MINUTES = 360;

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    for (var element of value) {
      if (!isEmptyValue(element)) {
        // the array has at least one non-empty element
        return false;
      }
    }
    // the array has no non-empty elements
    return true;
  }

  if (typeof value === 'object') {
    for (var childValue of Object.values(value)) {
      if (!isEmptyValue(childValue)) {
        // the object has at least one non-empty property
        return false;
      }
    }
    // the object has no non-empty property
    return true;
  }

  return false;
}

function emptyValueReplacer(_, value) {
  if (isEmptyValue(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter(e => !isEmptyValue(e));
  }

  return value;
}

function cleanNullKeys(obj) {
  return JSON.parse(JSON.stringify(obj, emptyValueReplacer));
}

function removeIgnoredAttributes(taskDef) {
  for (var attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
    if (taskDef[attribute]) {
      core.warning(`Ignoring property '${attribute}' in the task definition file. ` +
        'This property is returned by the Amazon ECS DescribeTaskDefinition API and may be shown in the ECS console, ' +
        'but it is not a valid field when registering a new task definition. ' +
        'This field can be safely removed from your task definition file.');
      delete taskDef[attribute];
    }
  }

  return taskDef;
}

function maintainValidObjects(taskDef) {
    if (validateProxyConfigurations(taskDef)) {
        taskDef.proxyConfiguration.properties.forEach((property, index, arr) => {
            if (!('value' in property)) {
                arr[index].value = '';
            }
            if (!('name' in property)) {
                arr[index].name = '';
            }
        });
    }

    if(taskDef && taskDef.containerDefinitions){
      taskDef.containerDefinitions.forEach((container) => {
        if(container.environment){
          container.environment.forEach((property, index, arr) => {
            if (!('value' in property)) {
              arr[index].value = '';
            }
          });
        }
      });
    }
    return taskDef;
}

function validateProxyConfigurations(taskDef){
  return 'proxyConfiguration' in taskDef && taskDef.proxyConfiguration.type && taskDef.proxyConfiguration.type == 'APPMESH' && taskDef.proxyConfiguration.properties && taskDef.proxyConfiguration.properties.length > 0;
}

async function run() {
  try {
    const agent = 'amazon-ecs-run-task-for-github-actions'

    const ecs = new aws.ECS({
      customUserAgent: agent
    });

    // Get inputs
    const taskDefinitionFile = core.getInput('task-definition', { required: true });
    const service = core.getInput('service', { required: true });
    const count = core.getInput('count', { required: true });
    const clusterName = core.getInput('cluster', { required: false }) || 'default';
    const startedBy = core.getInput('started-by', { required: false }) || agent;
    const waitForFinish = core.getInput('wait-for-finish', { required: false }) || false;
    let waitForMinutes = parseInt(core.getInput('wait-for-minutes', { required: false })) || 30;
    if (waitForMinutes > MAX_WAIT_MINUTES) {
      waitForMinutes = MAX_WAIT_MINUTES;
    }

    // Register the task definition
    core.debug('Registering the task definition');
    const taskDefPath = path.isAbsolute(taskDefinitionFile) ?
      taskDefinitionFile :
      path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
    const fileContents = fs.readFileSync(taskDefPath, 'utf8');
    const taskDefContents = maintainValidObjects(removeIgnoredAttributes(cleanNullKeys(yaml.parse(fileContents))));

    let registerResponse;
    try {
      registerResponse = await ecs.registerTaskDefinition(taskDefContents).promise();
    } catch (error) {
      core.setFailed("Failed to register task definition in ECS: " + error.message);
      core.debug("Task definition contents:");
      core.debug(JSON.stringify(taskDefContents, undefined, 4));
      throw(error);
    }
    const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
    core.setOutput('task-definition-arn', taskDefArn);

    // Fetch the configuration from a service
    core.debug('Fetch the configuration');
    let describeResponse;
    try {
      describeResponse = await ecs.describeServices({
        services: [service],
        cluster: clusterName
      }).promise();
    } catch (error) {
      core.setFailed("Failed to fetch the configuration from a service: " + error.message);
      throw(error);
    }
    const serviceResponse = describeResponse.services[0];

    core.debug(`Running task with ${JSON.stringify({
      count,
      startedBy,
      cluster: clusterName,
      taskDefinition: taskDefArn,
      capacityProviderStrategy: serviceResponse.capacityProviderStrategy,
      launchType: serviceResponse.launchType,
      networkConfiguration: serviceResponse.networkConfiguration,
    })}`)

    // Starts a new task
    let taskResponse;
    try {
      // const commandList = parseCommand(command);
      taskResponse = await ecs.runTask({
        count,
        startedBy,
        cluster: clusterName,
        taskDefinition: taskDefArn,
        capacityProviderStrategy: serviceResponse.capacityProviderStrategy,
        launchType: serviceResponse.launchType,
        networkConfiguration: serviceResponse.networkConfiguration,
        // overrides: {
        //   containerOverrides: [
        //     {
        //       name: container,
        //       command: commandList
        //     }
        //   ]
        // }
      }).promise();
    } catch (error) {
      core.setFailed("Failed to start a task in ECS: " + error.message);
      throw(error);
    }

    core.debug(`Run task response ${JSON.stringify(taskResponse)}`)

    if (taskResponse.failures && taskResponse.failures.length > 0) {
      const failure = taskResponse.failures[0];
      throw new Error(`${failure.arn} is ${failure.reason}`);
    }

    const taskArns = taskResponse.tasks.map(task => task.taskArn);

    core.setOutput('task-arn', taskArns);

    if (waitForFinish && waitForFinish.toLowerCase() === 'true') {
      await waitForTasksStopped(ecs, clusterName, taskArns, waitForMinutes);
      await tasksExitCode(ecs, clusterName, taskArns);
    }
  }
  catch (error) {
    core.setFailed(error.message);
    core.debug(error.stack);
  }
}

async function waitForTasksStopped(ecs, clusterName, taskArns, waitForMinutes) {
  if (waitForMinutes > MAX_WAIT_MINUTES) {
    waitForMinutes = MAX_WAIT_MINUTES;
  }

  const maxAttempts = (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC;

  core.debug('Waiting for tasks to stop');
  
  const waitTaskResponse = await ecs.waitFor('tasksStopped', {
    cluster: clusterName,
    tasks: taskArns,
    $waiter: {
      delay: WAIT_DEFAULT_DELAY_SEC,
      maxAttempts: maxAttempts
    }
  }).promise();

  core.debug(`Run task response ${JSON.stringify(waitTaskResponse)}`)
  
  core.info(`All tasks have stopped. Watch progress in the Amazon ECS console: https://console.aws.amazon.com/ecs/home?region=${aws.config.region}#/clusters/${clusterName}/tasks`);
}

async function tasksExitCode(ecs, clusterName, taskArns) {
  const describeResponse = await ecs.describeTasks({
    cluster: clusterName,
    tasks: taskArns
  }).promise();

  const containers = [].concat(...describeResponse.tasks.map(task => task.containers))
  const exitCodes = containers.map(container => container.exitCode)
  const reasons = containers.map(container => container.reason)

  const failuresIdx = [];
  
  exitCodes.filter((exitCode, index) => {
    if (exitCode !== 0) {
      failuresIdx.push(index)
    }
  })

  const failures = reasons.filter((_, index) => failuresIdx.indexOf(index) !== -1)

  if (failures.length > 0) {
    core.setFailed(failures.join("\n"));
  } else {
    core.info(`All tasks have exited successfully.`);
  }
}

module.exports = run;

/* istanbul ignore next */
if (require.main === module) {
    run();
}
