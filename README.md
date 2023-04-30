# phuzzylink
This is the repository for phuzzylink in KWG .

## Deploying

Before starting the server, first install the dependencies and run the npx build tool. The CSS files are generated with `transpile.sh`. You _may_ need to install less with

`npm install less -g`

```
npm install
cd plugins
npm install
cd ..
npx emk -f -w
sh transpile.sh
```

### Production and Development
To deploy on a production server or locally use,

`node src/server/server.js -p 3001`

### Staging
When deploying to staging, specify the endpoint using the `-e` flag,

`node src/server/server.js -e https://staging.knowwheregraph.org/graphdb/repositories/KWG -p 3001`

### Backgrounding the Process

When deploying on remote servers, you may want to run the process in the background so that you can exit ssh without stopping the process. To do this, use `nohup`

`nohup node src/server/server.js -p 3001 &`

## Developing

To make code contributions, check out a branch based on the `development` branch with `git checkout -bb development <your branch name>`. Create Pull requests into the `main` branch. For new releases, merge `develop` into `main`.