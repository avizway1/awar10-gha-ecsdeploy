# AWS setup for the GitHub Actions → ECS pipeline

Plain AWS CLI commands that create everything `.github/workflows/ecs-capstone.yaml` expects.
Run them **in order, in one terminal window, from the project folder** — later steps reuse the
variables set by earlier ones. (Opened a new terminal half-way? Run [Restore variables](#restore-variables).)

| | |
|---|---|
| Account / region | `992189742322` / `ap-south-1` (default VPC, 3 public subnets) |
| GitHub repo | `avizway1/awar10-gha-ecs`, branch `main` |
| Needs | AWS CLI v2, Docker Desktop **running**, `gh` logged in |
| Time | ~10 min for AWS, ~4 min for the first pipeline run |

What gets created:

```
GitHub push ──► Actions (OIDC role) ──► ECR image ──► new task definition ──► ECS service
                                                                                 │
Internet ──► ALB :80 ──► target group ──► Fargate tasks :3000 ──► DynamoDB table todo-tasks
```

---

## 0. Variables

```bash
export AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1 AWS_PAGER=""
export GITHUB_REPO=avizway1/awar10-gha-ecs
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REGISTRY=${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
echo ${ACCOUNT_ID} ${ECR_REGISTRY}
```

Expect `992189742322 992189742322.dkr.ecr.ap-south-1.amazonaws.com`.

## 1. DynamoDB table + sample tasks

```bash
aws dynamodb create-table --table-name todo-tasks \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

```bash
aws dynamodb wait table-exists --table-name todo-tasks
aws dynamodb batch-write-item --request-items file://seed-tasks.json
```

## 2. ECR repository

```bash
aws ecr create-repository --repository-name todo-app --image-scanning-configuration scanOnPush=true
```

## 3. CloudWatch log group

```bash
aws logs create-log-group --log-group-name /ecs/todo-app
aws logs put-retention-policy --log-group-name /ecs/todo-app --retention-in-days 7
```

## 4. IAM roles

The GitHub OIDC provider (`token.actions.githubusercontent.com`) **already exists** in this account — do not create it again.

**4a. Trust policy shared by both ECS roles**

```bash
cat > /tmp/todo-ecs-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF
```

**4b. Task execution role** — used by ECS to pull the image and write logs

```bash
aws iam create-role --role-name todo-app-ecs-exec-role --assume-role-policy-document file:///tmp/todo-ecs-trust.json
aws iam attach-role-policy --role-name todo-app-ecs-exec-role --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
export EXEC_ROLE_ARN=$(aws iam get-role --role-name todo-app-ecs-exec-role --query Role.Arn --output text)
```

**4c. Task role** — used by the app itself to read/write the DynamoDB table

```bash
cat > /tmp/todo-dynamodb-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
    "Resource": "arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/todo-tasks"
  }]
}
EOF
```

```bash
aws iam create-role --role-name todo-app-ecs-task-role --assume-role-policy-document file:///tmp/todo-ecs-trust.json
aws iam put-role-policy --role-name todo-app-ecs-task-role --policy-name dynamodb-tasks --policy-document file:///tmp/todo-dynamodb-policy.json
export TASK_ROLE_ARN=$(aws iam get-role --role-name todo-app-ecs-task-role --query Role.Arn --output text)
```

**4d. GitHub Actions role** — assumed by the workflow through OIDC (only from `main` of this repo)

```bash
cat > /tmp/todo-gha-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:${GITHUB_REPO}:ref:refs/heads/main"
      }
    }
  }]
}
EOF
```

```bash
cat > /tmp/todo-gha-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrLogin",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrPush",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"
      ],
      "Resource": "arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/todo-app"
    },
    {
      "Sid": "TaskDefinitions",
      "Effect": "Allow",
      "Action": ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"],
      "Resource": "*"
    },
    {
      "Sid": "DeployService",
      "Effect": "Allow",
      "Action": ["ecs:UpdateService", "ecs:DescribeServices"],
      "Resource": "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:service/todo-app-cluster/todo-app-service"
    },
    {
      "Sid": "PassTaskRoles",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": ["${EXEC_ROLE_ARN}", "${TASK_ROLE_ARN}"],
      "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }
    }
  ]
}
EOF
```

```bash
aws iam create-role --role-name todo-app-github-actions-role --assume-role-policy-document file:///tmp/todo-gha-trust.json
aws iam put-role-policy --role-name todo-app-github-actions-role --policy-name ecr-ecs-deploy --policy-document file:///tmp/todo-gha-policy.json
export GHA_ROLE_ARN=$(aws iam get-role --role-name todo-app-github-actions-role --query Role.Arn --output text)
```

## 5. Network: security groups, load balancer, target group

```bash
export VPC_ID=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
export SUBNETS_CSV=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=${VPC_ID} Name=default-for-az,Values=true --query 'join(`,`, Subnets[].SubnetId)' --output text)
echo ${VPC_ID} ${SUBNETS_CSV}
```

```bash
export ALB_SG=$(aws ec2 create-security-group --group-name todo-app-alb-sg --description "todo-app ALB - HTTP from internet" --vpc-id ${VPC_ID} --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id ${ALB_SG} --protocol tcp --port 80 --cidr 0.0.0.0/0
```

```bash
export TASK_SG=$(aws ec2 create-security-group --group-name todo-app-task-sg --description "todo-app tasks - port 3000 from ALB only" --vpc-id ${VPC_ID} --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id ${TASK_SG} --protocol tcp --port 3000 --source-group ${ALB_SG}
```

```bash
export ALB_ARN=$(aws elbv2 create-load-balancer --name todo-app-alb --type application --scheme internet-facing \
  --subnets $(echo ${SUBNETS_CSV} | tr ',' ' ') --security-groups ${ALB_SG} \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)
```

```bash
export TG_ARN=$(aws elbv2 create-target-group --name todo-app-tg --protocol HTTP --port 3000 --vpc-id ${VPC_ID} --target-type ip \
  --health-check-path /health --health-check-interval-seconds 10 --health-check-timeout-seconds 5 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 modify-target-group-attributes --target-group-arn ${TG_ARN} --attributes Key=deregistration_delay.timeout_seconds,Value=30
```

```bash
aws elbv2 create-listener --load-balancer-arn ${ALB_ARN} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${TG_ARN}
```

> The short health-check interval and the 30 s deregistration delay keep each pipeline deploy to ~3 minutes
> (the defaults make it 8+ minutes).

## 6. ECS cluster

```bash
aws ecs create-cluster --cluster-name todo-app-cluster
```

## 7. First image (bootstrap)

The service needs an image before the pipeline has ever run. `--platform linux/amd64` is required on an
Apple Silicon Mac — Fargate runs this task as X86_64.

```bash
aws ecr get-login-password | docker login --username AWS --password-stdin ${ECR_REGISTRY}
docker buildx build --platform linux/amd64 -t ${ECR_REGISTRY}/todo-app:bootstrap --push .
```

## 8. Task definition

```bash
cat > /tmp/todo-taskdef.json <<EOF
{
  "family": "todo-app-task",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512",
  "runtimePlatform": { "cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "${EXEC_ROLE_ARN}",
  "taskRoleArn": "${TASK_ROLE_ARN}",
  "containerDefinitions": [{
    "name": "todo-app",
    "image": "${ECR_REGISTRY}/todo-app:bootstrap",
    "essential": true,
    "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
    "environment": [
      { "name": "TABLE_NAME", "value": "todo-tasks" },
      { "name": "AWS_REGION", "value": "${AWS_REGION}" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/todo-app",
        "awslogs-region": "${AWS_REGION}",
        "awslogs-stream-prefix": "ecs"
      }
    }
  }]
}
EOF
```

```bash
aws ecs register-task-definition --cli-input-json file:///tmp/todo-taskdef.json --query 'taskDefinition.taskDefinitionArn' --output text
```

## 9. ECS service

```bash
aws ecs create-service --cluster todo-app-cluster --service-name todo-app-service \
  --task-definition todo-app-task --desired-count 2 --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS_CSV}],securityGroups=[${TASK_SG}],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=${TG_ARN},containerName=todo-app,containerPort=3000" \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" \
  --query 'service.serviceArn' --output text
```

```bash
aws ecs wait services-stable --cluster todo-app-cluster --services todo-app-service
export ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns ${ALB_ARN} --query 'LoadBalancers[0].DNSName' --output text)
curl -s http://${ALB_DNS}/health
echo "Open http://${ALB_DNS}"
```

`{"status":"ok"}` means the app is up. Open the URL — the 3 sample tasks are shown. (A brand-new ALB name can take
1–2 minutes to resolve in DNS.)

## 10. GitHub repository, variables, secret — then push

Variables and the secret must exist **before** the first push, because the push starts the workflow.

```bash
gh repo create ${GITHUB_REPO} --public
```

```bash
gh variable set AWS_REGION --repo ${GITHUB_REPO} --body ap-south-1
gh variable set ECR_REPO_NAME --repo ${GITHUB_REPO} --body todo-app
gh variable set ECS_CLUSTER_NAME --repo ${GITHUB_REPO} --body todo-app-cluster
gh variable set ECS_SERVICE_NAME --repo ${GITHUB_REPO} --body todo-app-service
gh variable set ECS_TASK_DEF_NAME --repo ${GITHUB_REPO} --body todo-app-task
gh variable set ECS_CONTAINER_NAME --repo ${GITHUB_REPO} --body todo-app
gh secret set AWS_ROLE_ARN --repo ${GITHUB_REPO} --body ${GHA_ROLE_ARN}
gh variable list --repo ${GITHUB_REPO}
```

```bash
git init -b main
git add .
git commit -m "To-do app with DynamoDB, deployed to ECS by GitHub Actions"
git remote add origin https://github.com/${GITHUB_REPO}.git
git push -u origin main
```

```bash
gh run watch --repo ${GITHUB_REPO}
```

When the run is green, refresh `http://${ALB_DNS}`. To show a change going live: edit something visible
(e.g. the footer in `public/index.html`), commit, push, and watch it roll out with zero downtime. Tasks
created in the UI survive every deploy because they live in DynamoDB:

```bash
aws dynamodb scan --table-name todo-tasks --select COUNT
```

---

## If something goes wrong

| Symptom | Cause / fix |
|---|---|
| Workflow: `Not authorized to perform sts:AssumeRoleWithWebIdentity` | Repo or branch differs from the trust policy (`repo:avizway1/awar10-gha-ecs:ref:refs/heads/main`). Fix `/tmp/todo-gha-trust.json`, then `aws iam update-assume-role-policy --role-name todo-app-github-actions-role --policy-document file:///tmp/todo-gha-trust.json` |
| Workflow: `not authorized to perform: iam:PassRole` | Re-run the `put-role-policy` in step 4d (both role ARNs must be set) |
| Workflow: `Unable to process task definition family` / container name | A GitHub variable is misspelled — `gh variable list --repo ${GITHUB_REPO}` |
| Deploy waits, then rolls back | `aws ecs describe-services --cluster todo-app-cluster --services todo-app-service --query 'services[0].events[:5].message'` and `aws logs tail /ecs/todo-app --since 15m` |
| Logs show `exec format error` | Image was built for arm64 — rebuild step 7 with `--platform linux/amd64` |
| App shows no tasks / API returns `{"error":"Storage error"}` | Task role or table problem — `aws logs tail /ecs/todo-app --since 15m` shows the DynamoDB error |
| `502 Bad Gateway` from the ALB | Tasks are still starting — wait ~1 minute |

## Restore variables

New terminal half-way through? Run this from the project folder, then continue where you stopped.
Lines for resources you have not created yet just print `None`.

```bash
export AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1 AWS_PAGER=""
export GITHUB_REPO=avizway1/awar10-gha-ecs
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REGISTRY=${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
export EXEC_ROLE_ARN=arn:aws:iam::${ACCOUNT_ID}:role/todo-app-ecs-exec-role
export TASK_ROLE_ARN=arn:aws:iam::${ACCOUNT_ID}:role/todo-app-ecs-task-role
export GHA_ROLE_ARN=arn:aws:iam::${ACCOUNT_ID}:role/todo-app-github-actions-role
export VPC_ID=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
export SUBNETS_CSV=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=${VPC_ID} Name=default-for-az,Values=true --query 'join(`,`, Subnets[].SubnetId)' --output text)
export ALB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=todo-app-alb-sg --query 'SecurityGroups[0].GroupId' --output text)
export TASK_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=todo-app-task-sg --query 'SecurityGroups[0].GroupId' --output text)
export ALB_ARN=$(aws elbv2 describe-load-balancers --query "LoadBalancers[?LoadBalancerName=='todo-app-alb'].LoadBalancerArn | [0]" --output text)
export TG_ARN=$(aws elbv2 describe-target-groups --query "TargetGroups[?TargetGroupName=='todo-app-tg'].TargetGroupArn | [0]" --output text)
echo ${VPC_ID} ${SUBNETS_CSV} ${ALB_SG} ${TASK_SG} ${ALB_ARN} ${TG_ARN}
```

## Clean up after the class

The ALB, two Fargate tasks and their public IPs cost roughly $2 per day together. Delete everything (the shared OIDC provider is kept):

```bash
aws ecs update-service --cluster todo-app-cluster --service todo-app-service --desired-count 0 --query 'service.desiredCount'
aws ecs delete-service --cluster todo-app-cluster --service todo-app-service --force --query 'service.status'
aws ecs wait services-inactive --cluster todo-app-cluster --services todo-app-service
aws ecs delete-cluster --cluster todo-app-cluster --query 'cluster.status'
for td in $(aws ecs list-task-definitions --family-prefix todo-app-task --query 'taskDefinitionArns[]' --output text); do aws ecs deregister-task-definition --task-definition ${td} --query 'taskDefinition.status'; done
```

```bash
aws elbv2 delete-load-balancer --load-balancer-arn $(aws elbv2 describe-load-balancers --names todo-app-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text)
aws elbv2 wait load-balancers-deleted --names todo-app-alb
aws elbv2 delete-target-group --target-group-arn $(aws elbv2 describe-target-groups --names todo-app-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
```

Security groups can only be deleted once the task network interfaces are gone — if you get
`DependencyViolation`, wait a minute and run the same command again.

```bash
aws ec2 delete-security-group --group-id $(aws ec2 describe-security-groups --filters Name=group-name,Values=todo-app-task-sg --query 'SecurityGroups[0].GroupId' --output text)
aws ec2 delete-security-group --group-id $(aws ec2 describe-security-groups --filters Name=group-name,Values=todo-app-alb-sg --query 'SecurityGroups[0].GroupId' --output text)
```

```bash
aws ecr delete-repository --repository-name todo-app --force --query 'repository.repositoryName'
aws dynamodb delete-table --table-name todo-tasks --query 'TableDescription.TableStatus'
aws logs delete-log-group --log-group-name /ecs/todo-app
aws iam delete-role-policy --role-name todo-app-github-actions-role --policy-name ecr-ecs-deploy
aws iam delete-role --role-name todo-app-github-actions-role
aws iam delete-role-policy --role-name todo-app-ecs-task-role --policy-name dynamodb-tasks
aws iam delete-role --role-name todo-app-ecs-task-role
aws iam detach-role-policy --role-name todo-app-ecs-exec-role --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name todo-app-ecs-exec-role
```
