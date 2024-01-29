# @awboost/cfn-deploy

CloudFormation deployment CLI tool. Create, update and delete stacks with streaming logs.

## Usage

```
Usage: cfn-deploy [options] [command]

Create, update and delete CloudFormation stacks with streaming logs.

Options:
  --access-key-id <value>         the AWS access key ID (env: AWS_ACCESS_KEY_ID)
  --secret-access-key <value>     the AWS secret access key (env: AWS_SECRET_ACCESS_KEY)
  --session-token <value>         the AWS session token (env: AWS_SESSION_TOKEN)
  --region <value>                the AWS region (env: AWS_REGION)
  --config <path>                 path to the config file (default: ".cfn-deploy.json")
  --no-config                     skip trying to load a config file
  -p, --profile <name>            the profile to use with aws-vault (env: AWS_VAULT)
  -h, --help                      display help for command

Commands:
  upload [options] <template>     upload a template and associated assets to S3
  changeset [options] <template>  create a changeset and optionally execute it
  delete <stackNameOrId>          delete a stack and all of its resources
  help [command]                  display help for command
```
