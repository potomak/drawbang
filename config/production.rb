# s3 bucket
S3_BUCKET = 'draw.heroku.com'

# redis
uri = URI.parse(ENV["REDISTOGO_URL"])
REDIS = Redis.new(:host => uri.host, :port => uri.port, :password => uri.password)

# facebook
FACEBOOK = {'app_id' => ENV["FB_APP_ID"], 'app_secret' => ENV["FB_APP_SECRET"]}