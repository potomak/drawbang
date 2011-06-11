# drawings path
DRAWINGS_PATH = File.join('public', 'images', 'drawings')

# redis
REDIS = Redis.new(:host => 'localhost', :port => 6379)

# facebook
FACEBOOK = YAML.load_file('config/facebook.yml') unless defined?(FACEBOOK)