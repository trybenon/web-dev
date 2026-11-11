.PHONY: run stop logs status config build

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
