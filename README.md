# ![Draw!](https://github.com/potomak/drawbang/raw/develop/public/favicon.ico "Draw!") Draw! (drawbang)

Draw 16 x 16 animated pictures. Draw! is a social flavored online pixel art editor.

Draw! it's also an experiment app about:

* html5 canvas element through the [pixel library](http://github.com/potomak/jquery-pixel).
* redis

Follow [@drawbang](http://twitter.com/drawbang) and read the blog at [http://blog.drawbang.com](http://github.com/potomak/jquery-pixel).

## Required gems

`bundler` and `heroku` gems are needed, than just run

    bundle

to install other required gems.

See also [`Gemfile`](https://github.com/potomak/drawbang/raw/master/Gemfile)

## How to run the app locally

Copy Facebook config file example

    cp config/facebook.example.yml config/facebook.yml

Start Redis server

    redis-server config/redis.conf

Run

    ruby server.rb

or run rake task `server`, alias `s`

    rake s

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

or run rake task `console`, alias `c`

    rake c

### Get application users and drawings stats

Run

    rake stats

## License

Draw! (drawbang) is released under the MIT license.

## How to contribute

If you find what looks like a bug:

1. Check the [GitHub issue tracker](https://github.com/potomak/drawbang/issues) to see if anyone else has reported issue.
1. If you don’t see anything, create an issue with information on how to reproduce it.

If you want to contribute an enhancement or a fix:

1. Fork the project on github.
1. Make your changes with tests.
1. Commit the changes without making changes to the Rakefile or any other files that aren’t related to your enhancement or fix
1. Send a pull request.