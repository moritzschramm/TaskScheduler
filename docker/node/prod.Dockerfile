FROM node:21
WORKDIR /usr/src/app

COPY ../../client .

RUN npm install
CMD npm run build
