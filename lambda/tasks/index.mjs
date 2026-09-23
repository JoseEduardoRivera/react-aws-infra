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
