// Synchronously invoke an emulated Lambda function, like `aws lambda invoke` / `bref cli`.
//
//   node src/invoke.mjs <function-name> '<json-payload>'
//   node src/invoke.mjs artisan "migrate --force"      # shortcut for the console function
//
// Prints the function result. For the Bref console function it prints the artisan output and
// exits with the artisan exit code.

const [, , target, ...rest] = process.argv;
if (!target) {
  process.stderr.write("usage: invoke.mjs <function|artisan> <payload|artisan args>\n");
  process.exit(2);
}

const host = process.env.AWS_HOST ?? "127.0.0.1";
const port = process.env.AWS_PORT ?? "9001";
const isArtisan = target === "artisan";
const fn = isArtisan ? (process.env.CONSOLE_FUNCTION ?? "battle-arena-api-console") : target;
const payload = isArtisan ? JSON.stringify(rest.join(" ")) : (rest.join(" ") || "{}");

const response = await fetch(`http://${host}:${port}/2015-03-31/functions/${encodeURIComponent(fn)}/invocations`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Amz-Invocation-Type": "RequestResponse" },
  body: payload,
});
const text = await response.text();
const functionError = response.headers.get("x-amz-function-error");

if (isArtisan) {
  try {
    const result = JSON.parse(text);
    if (result && typeof result === "object" && "output" in result) {
      process.stdout.write(`${String(result.output)}\n`);
      process.exit(Number(result.exitCode ?? (functionError ? 1 : 0)));
    }
  } catch {
    // fall through to raw output
  }
}

process.stdout.write(`${text}\n`);
process.exit(response.ok && !functionError ? 0 : 1);
