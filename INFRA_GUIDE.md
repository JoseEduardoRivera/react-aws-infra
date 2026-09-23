# Guía de referencia — react-aws-infra

Guía consultable para levantar infraestructura AWS con CDK + Docker, usando este proyecto como base reutilizable.

---

## 1. Cómo iniciar un proyecto de infraestructura (CDK)

```bash
mkdir mi-proyecto-infra
cd mi-proyecto-infra
cdk init app --language typescript
```

Esto genera:

```
mi-proyecto-infra/
├── bin/mi-proyecto-infra.ts   # entry point — instancia el/los stack(s)
├── lib/mi-proyecto-infra-stack.ts   # donde defines los recursos (Lambda, DynamoDB, API, etc.)
├── test/                       # tests con Jest
├── cdk.json                    # config de CDK (comando para ejecutar el entry point, contexto)
├── package.json
└── tsconfig.json
```

El flujo de trabajo diario es:

1. Editar `lib/*-stack.ts` para declarar/modificar recursos.
2. `cdk synth` — genera el CloudFormation template, valida que compile (no despliega).
3. `cdk deploy` — aplica los cambios contra AWS real (te muestra el diff antes de confirmar).
4. `cdk destroy` — borra todo lo que el stack creó (útil para limpiar cuentas de práctica).

---

## 2. Requisitos

| Requisito | Verificar con | Notas |
|---|---|---|
| Cuenta AWS + usuario IAM con permisos | `aws sts get-caller-identity` | El usuario necesita al menos permisos para los servicios que uses (Lambda, DynamoDB, API Gateway, IAM, CloudFormation, ECR) |
| AWS CLI configurado | `aws --version` | `aws configure` para setear access key, secret, región |
| Node.js (LTS reciente) | `node --version` | CDK y las Lambdas lo requieren |
| AWS CDK CLI | `cdk --version` | `npm install -g aws-cdk` |
| Bootstrap de la cuenta/región | ver stack `CDKToolkit` en CloudFormation | `cdk bootstrap aws://ACCOUNT_ID/REGION` — una sola vez por cuenta+región. Crea el bucket S3 de assets, repo ECR y roles IAM que CDK necesita para desplegar |
| Docker Desktop corriendo | `docker ps` | Necesario si usas Lambdas como imagen de contenedor (CDK construye la imagen localmente antes de subirla a ECR) o si usas DynamoDB Local |

---

## 3. Sección Docker

### Archivos que necesita una Lambda containerizada

Dentro de la carpeta de cada función (ej. `lambda/tasks/`):

| Archivo | Rol |
|---|---|
| `Dockerfile` | Define la imagen: base image, qué se copia, cómo se instalan dependencias, cuál es el handler |
| `package.json` | Declara las dependencias npm que la imagen necesita instalar (a diferencia del deploy por zip, donde el SDK de AWS ya viene incluido en el runtime managed, en modo contenedor hay que declararlo explícitamente) |
| `index.mjs` (o `.js`) | El código del handler. `.mjs` = ES Modules (`import`/`export`); si usas `.js` normal necesitas `"type": "module"` en el `package.json` para poder usar `import` |

### Archivo a nivel raíz del proyecto de infra

| Archivo | Rol |
|---|---|
| `docker-compose.yml` | Orquesta múltiples contenedores juntos para desarrollo local (ej. la Lambda + una base de datos local), conectados en la misma red interna de Docker |

### Comandos clave

```bash
# Build manual de una imagen
docker build -t tasks-lambda ./lambda/tasks

# Correr una Lambda-imagen sueltamente y probarla con el Runtime Interface Emulator
docker run -p 9000:8080 tasks-lambda
curl "http://localhost:9000/2015-03-31/functions/function/invocations" -d '{"requestContext":{"http":{"method":"GET"}}}'

# Con docker-compose (ver scripts en package.json de este proyecto)
npm run docker:up:build   # levanta y reconstruye imágenes
npm run docker:up         # levanta sin reconstruir
npm run docker:down       # detiene (agrega -v para además borrar volúmenes)
```

### Problemas comunes (ya nos pasaron en este proyecto)

- **Puerto ocupado** (`port is already allocated`): un contenedor viejo (creado con `docker run` suelto o de un intento anterior fallido) sigue reteniendo el puerto. `docker ps -a`, `docker stop <id>`, `docker rm <id>`, y reintentar.
- **`UnknownHostException` de log4j al arrancar DynamoDB Local**: cosmético, no afecta funcionalidad — el contenedor no puede resolver su propio hostname interno, pero sigue arrancando bien.
- **`SQLiteException: unable to open database file`**: permisos — un named volume nuevo lo crea Docker con dueño `root`, pero la imagen corre con un usuario sin privilegios. Fix: agregar `user: root` al servicio en `docker-compose.yml`.
- **Comillas/JSON inline en PowerShell**: PowerShell rompe JSON con comillas anidadas pasado como argumento a comandos nativos (`aws`, `curl`). Usa `--item file://archivo.json` en vez de JSON inline, o corre esos comandos desde Git Bash.

---

## 4. Comparativa: apuntando a AWS real vs. apuntando a Docker local

| | **AWS real** (`cdk deploy`) | **Docker local** (`docker compose up`) |
|---|---|---|
| Dónde corre la Lambda | Servicio Lambda de AWS | Contenedor local con el Runtime Interface Emulator |
| Dónde corre la base de datos | DynamoDB real (tabla `Tasks-cdk`) | Contenedor `amazon/dynamodb-local` (tabla `Tasks-local`) |
| Variable `DYNAMODB_ENDPOINT` | No seteada → el SDK usa el endpoint real de AWS según la región | Seteada a `http://dynamodb-local:8000` (nombre del servicio en la red de docker-compose) |
| Credenciales | El rol IAM de la Lambda (asumido automáticamente, sin claves) | Variables dummy (`AWS_ACCESS_KEY_ID=local`, etc.) — DynamoDB Local no las valida |
| Cómo se despliega | `cdk deploy` — construye la imagen, la sube a ECR, actualiza CloudFormation | `docker compose up --build` — solo build local, nunca toca AWS ni gasta crédito |
| Persistencia de datos | Administrada por AWS (durable) | Named volume de Docker (`dynamodb-data`) — persiste entre reinicios del contenedor, se pierde si borras el volumen |
| URL de acceso | La `ApiUrl` que imprime `cdk deploy` (API Gateway real) | `http://localhost:9000/2015-03-31/functions/function/invocations` (invocación directa, sin API Gateway local) |
| Costo | Dentro de free tier / créditos, pero es AWS real | Gratis, 100% local |

El mismo código de la Lambda (`index.mjs`) sirve para ambos casos gracias al patrón:
```javascript
const client = new DynamoDBClient({
  ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
});
```
Si `DYNAMODB_ENDPOINT` no existe (como en producción real), el SDK usa el comportamiento default apuntando a AWS.

---

## 5. Ejemplos de código (base actual de este proyecto)

### `lib/react-aws-infra-stack.ts` — Stack CDK completo

```typescript
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as path from "path";

export class ReactAwsInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, "TasksTable", {
      tableName: "Tasks-cdk",
      partitionKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // ok para aprendizaje; nunca en prod
    });

    const tasksFn = new lambda.DockerImageFunction(this, "TasksFunction", {
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, "../lambda/tasks"),
      ),
      environment: {
        TABLE_NAME: table.tableName,
      },
    });

    table.grantReadWriteData(tasksFn);

    const httpApi = new apigwv2.HttpApi(this, "TasksHttpApi", {
      corsPreflight: {
        allowOrigins: ["http://localhost:5173"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ["Content-Type"],
      },
    });

    const integration = new integrations.HttpLambdaIntegration(
      "TasksIntegration",
      tasksFn,
    );

    httpApi.addRoutes({
      path: "/tasks",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
    });
    httpApi.addRoutes({
      path: "/tasks/{taskId}",
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration,
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
  }
}
```

**Patrón reutilizable**: `Table` → `Function` (zip o Docker) → `table.grantReadWriteData(fn)` (permisos automáticos) → `HttpApi` con `HttpLambdaIntegration` → `addRoutes`. Este esqueleto sirve para cualquier CRUD serverless nuevo, solo cambia el nombre de la tabla, el partition/sort key, y la lógica del handler.

### `lambda/tasks/Dockerfile`

```dockerfile
FROM public.ecr.aws/lambda/nodejs:22

COPY package.json ${LAMBDA_TASK_ROOT}
RUN npm install --omit=dev

COPY index.mjs ${LAMBDA_TASK_ROOT}

CMD ["index.handler"]
```

### `lambda/tasks/package.json`

```json
{
  "name": "tasks-lambda",
  "type": "module",
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.600.0",
    "@aws-sdk/lib-dynamodb": "^3.600.0"
  }
}
```

### `lambda/tasks/index.mjs` — Handler con routing por método HTTP

```javascript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const client = new DynamoDBClient({
  ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME;

export const handler = async (event) => {
  const method = event.requestContext.http.method;
  const taskId = event.pathParameters?.taskId;

  try {
    if (method === "GET") {
      const result = await docClient.send(
        new ScanCommand({ TableName: TABLE_NAME }),
      );
      return respond(200, result.Items);
    }
    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      const newTask = { taskId: randomUUID(), title: body.title, done: false };
      await docClient.send(
        new PutCommand({ TableName: TABLE_NAME, Item: newTask }),
      );
      return respond(201, newTask);
    }
    if (method === "PUT") {
      const body = JSON.parse(event.body || "{}");
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { taskId },
          UpdateExpression: "SET title = :title, done = :done",
          ExpressionAttributeValues: {
            ":title": body.title,
            ":done": body.done,
          },
        }),
      );
      return respond(200, { taskId, ...body });
    }
    if (method === "DELETE") {
      await docClient.send(
        new DeleteCommand({ TableName: TABLE_NAME, Key: { taskId } }),
      );
      return respond(204, null);
    }
    return respond(405, { message: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return respond(500, { message: "Internal error" });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: body === null ? "" : JSON.stringify(body),
  };
}
```

### `docker-compose.yml` — Lambda + DynamoDB Local orquestados juntos

```yaml
services:
  dynamodb-local:
    image: amazon/dynamodb-local
    user: root
    ports:
      - "8000:8000"
    command: -jar DynamoDBLocal.jar -sharedDb -dbPath ./data
    volumes:
      - dynamodb-data:/home/dynamodblocal/data

  tasks-lambda:
    build: ./lambda/tasks
    ports:
      - "9000:8080"
    environment:
      - TABLE_NAME=Tasks-local
      - DYNAMODB_ENDPOINT=http://dynamodb-local:8000
      - AWS_ACCESS_KEY_ID=local
      - AWS_SECRET_ACCESS_KEY=local
      - AWS_REGION=us-east-1
    depends_on:
      - dynamodb-local

volumes:
  dynamodb-data:
```

### Scripts de `package.json` (raíz del proyecto infra)

```json
"scripts": {
  "build": "tsc",
  "watch": "tsc -w",
  "test": "jest",
  "cdk": "cdk",
  "docker:up": "docker compose up",
  "docker:up:build": "docker compose up --build",
  "docker:down": "docker compose down"
}
```

---

## 6. Checklist para clonar este patrón en un proyecto nuevo

1. `cdk init app --language typescript` en la carpeta nueva.
2. Copiar la carpeta `lambda/<nombre>/` (Dockerfile + package.json + handler) como punto de partida, ajustando dependencias y lógica.
3. Copiar y adaptar `lib/*-stack.ts`: cambiar `tableName`, partition/sort key, rutas del API, nombre de las variables de entorno.
4. Copiar `docker-compose.yml`, ajustando el nombre de la tabla local y el puerto si ya tienes otro proyecto usando `8000`/`9000`.
5. Copiar los scripts `docker:*` al `package.json`.
6. `cdk bootstrap` si es una cuenta/región nueva que nunca se ha usado con CDK.
7. `cdk synth` → `cdk deploy`.
