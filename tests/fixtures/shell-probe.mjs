// A tiny program the `!command` tests run through the real shell: what it does depends on its first argument.
const [mode, value] = process.argv.slice(2);
if (mode === 'echo') { process.stdout.write('hello 한글\n'); process.stderr.write('warn\n'); process.exit(Number(value ?? 0)); }
else if (mode === 'cwd') process.stdout.write(process.cwd() + '\n');
else if (mode === 'env') process.stdout.write(`${process.env[value] ?? ''}|${process.env.TERM}\n`);
else if (mode === 'stdin') { let size = 0; process.stdin.on('data', chunk => { size += chunk.length; }).on('end', () => process.stdout.write(`stdin closed after ${size} bytes\n`)); }
else if (mode === 'sleep') { process.stdout.write('started\n'); setTimeout(() => {}, 60_000); }
else if (mode === 'loud') { const chunk = 'x'.repeat(65536); const timer = setInterval(() => process.stdout.write(chunk), 1); timer.unref; }
