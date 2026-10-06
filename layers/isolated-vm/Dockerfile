# Builds the isolated-vm native addon against the Lambda Node 22 image (spike
# S-1): webpack cannot bundle a .node binary, so the addon ships as a layer.
FROM public.ecr.aws/lambda/nodejs:22 AS build
RUN dnf install -y gcc-c++ make python3 && dnf clean all
WORKDIR /build/nodejs
COPY nodejs/package.json nodejs/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
RUN node -e "const ivm=require('isolated-vm'); const i=new ivm.Isolate({memoryLimit:32}); const c=i.createContextSync(); console.log('layer probe:', c.evalSync('1+1'), 'globals:', c.evalSync('typeof require + \",\" + typeof process + \",\" + typeof fetch')); i.dispose();"

FROM scratch AS export
COPY --from=build /build/nodejs /nodejs
