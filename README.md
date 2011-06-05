# jQuery pixel example app

An example app showing usage of the [jQuery pixel library](http://github.com/potomak/jquery-pixel).

## Required gems

1. `sinatra --version '>= 1.0'`
1. `haml`
1. `aws-s3`

## How to run the app locally

Run

    ruby server.rb

## How to use Heroku

### Create Heroku app

Run

    heroku create

### Push app to Heroku

Run

    git push heroku master

### Configuration variables

To see current configuration variables run

    heroku config

To add configuration variables run

    heroku config:add S3_KEY=xxx S3_SECRET=xxx