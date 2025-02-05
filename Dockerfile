# base upon nodejs lts, apline version for smaller container size
FROM node:lts-alpine as builder

# Enable correct timezone inside container
# Pass TZ env from docker run
RUN apk update && apk add --no-cache tzdata

# working directory inside the container
WORKDIR /opt/Nest_accfactory

# copy require files into container image folder
COPY package.json ./
COPY Nest_accfactory.js ./
COPY Nest_camera_*.jpg ./
COPY HomeKitHistory.js ./
COPY HomeKitDevice.js ./
COPY nexusstreamer.js ./

# perform installation based on details in package.json
RUN npm install

# run the accessory
ENTRYPOINT ["node"]
CMD ["/opt/Nest_accfactory/Nest_accfactory.js", "/opt/Nest_accfactory/conf/Nest_config.json"]

# labels for the container
LABEL org.opencontainers.image.title="Nest_accfactory_ft"
LABEL org.opencontainers.image.description="HomeKit integration for Nest devices based on HAP-NodeJS library"
LABEL org.opencontainers.image.url="https://github.com/GoWithitRoger/Nest_accfactory_ft"
LABEL org.opencontainers.image.authors="gypsum_rope0f@icloud.com"
LABEL org.opencontainers.image.version="v0.1.2"
