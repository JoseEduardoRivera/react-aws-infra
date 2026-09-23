FROM public.ecr.aws/lambda/nodejs:22

COPY package.json ${LAMBDA_TASK_ROOT}
RUN npm install --omit=dev

COPY index.mjs ${LAMBDA_TASK_ROOT}

CMD ["index.handler"]
