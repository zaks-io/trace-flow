import husky from 'husky';

// Husky's CLI prints Git errors without a failing exit status.
const message = husky();
if (message) {
  if (process.env.HUSKY === '0') {
    console.log(message);
  } else {
    console.error(message);
    process.exitCode = 1;
  }
}
