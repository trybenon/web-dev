.PHONY: run stop logs status config build run-release build-release

run:
	docker compose up --build

stop:
	docker compose down

logs:
	docker compose logs --follow

status:
	docker compose ps

config:
	docker compose config

build:
	docker compose build

build-release:
	BUGSINK_UPLOAD_NONCE=$$(date +%s) docker compose -f docker-compose.yml -f compose.release.yml build app

run-release:
	BUGSINK_UPLOAD_NONCE=$$(date +%s) docker compose -f docker-compose.yml -f compose.release.yml up --build --detach --wait --wait-timeout 120
