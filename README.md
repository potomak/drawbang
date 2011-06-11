# jQuery pixel example app

An example app showing usage of the [jQuery pixel library](http://github.com/potomak/jquery-pixel).

## Required gems

`bundler` and `heroku` gems are needed, than just run

    bundle

to install other required gems.

See also [`Gemfile`](https://github.com/potomak/jquery-pixel-app/raw/master/Gemfile)

## How to run the app locally

Run

    ruby server.rb

### Start the app console

Run

    irb -r server.rb

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

### Get Heroku logs

To see Heroku logs run

    heroku logs

### Run Heroku console

Run

    heroku console