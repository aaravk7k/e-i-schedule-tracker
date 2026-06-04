FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js app.js index.html styles.css README.md ./
COPY seed-data ./seed-data

ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data
ENV AIRTABLE_TABLE_TASKS=Tasks
ENV AIRTABLE_TABLE_STUDENTS=Students
ENV AIRTABLE_TABLE_SCHEDULES=Schedules
ENV AIRTABLE_TABLE_SPACES=Spaces

VOLUME ["/data"]

EXPOSE 8787

CMD ["npm", "start"]
